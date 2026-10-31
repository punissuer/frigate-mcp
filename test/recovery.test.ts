import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { connectFrigateStdio, frigateNamespace } from '../src/durable.js';
import { startFixture } from './helpers/fixture.js';
import { serverParameters } from './helpers/durable.js';
import { recoveryScript } from './helpers/recovery-script.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const PASSWORD = 'sup3r-secret-password';
const CHILD = fileURLToPath(new URL('./helpers/recovery-child.ts', import.meta.url));

const script = recoveryScript;

test('a crashed investigation resumes without repeating committed observations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frigate-mcp-recovery-'));
  const storagePath = join(directory, 'session.sqlite');
  const artifactDir = join(directory, 'artifacts');
  // The configuration read stalls, so the crash lands while a nested call is
  // in flight and its result is not yet committed.
  const fixture = await startFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    override: (req, res) => {
      // Only the first configuration read stalls, so the crash lands while that
      // nested call is in flight; the replayed read then completes.
      if (!req.url?.endsWith('/config') || stalled) return false;
      stalled = true;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"cameras"');
      return true;
    },
  });
  let stalled = false;
  try {
    const child = spawn(process.execPath, ['--import', 'tsx', CHILD, storagePath, fixture.apiRoot, artifactDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const submissionLine = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The child did not submit: ${stderr}`)), 20_000);
      const check = () => {
        const match = /\{"submission":(\d+),"pid":(\d+)\}/.exec(stdout);
        if (match) { clearTimeout(timer); resolve(match[0]); }
        else setTimeout(check, 50);
      };
      check();
    });
    const { submission: submissionId, pid: serverPid } = JSON.parse(submissionLine) as { submission: number; pid: number | null };

    // Wait until the configuration read is in flight, then kill the process.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The configuration read never started')), 20_000);
      const check = () => {
        if (fixture.requests.some(request => request.path.endsWith('/config'))) { clearTimeout(timer); resolve(); }
        else setTimeout(check, 25);
      };
      check();
    });
    child.kill('SIGKILL');
    await once(child, 'exit');
    // The orphaned MCP server must exit on its own when its stdin closes.
    if (serverPid) {
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const check = () => {
          try { process.kill(serverPid, 0); }
          catch { resolve(); return; }
          if (Date.now() > deadline) { reject(new Error('The MCP server process outlived the crash')); return; }
          setTimeout(check, 50);
        };
        check();
      });
    }

    const statusRequests = fixture.requests.filter(request => request.path.endsWith('/stats')).length;
    const configRequests = fixture.requests.filter(request => request.path.endsWith('/config')).length;
    assert.equal(statusRequests, 1, 'the committed status read is observed once before the crash');
    assert.equal(configRequests, 1, 'the configuration read was in flight when the process died');

    // Reopen the same storage, reinstall the registrations, and resume.
    const storage = await openNodeSqliteStorage(storagePath);
    const bridge = await connectFrigateStdio({
      command: process.execPath,
      args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
      env: {
        FRIGATE_API_ROOT: fixture.apiRoot,
        FRIGATE_ALLOW_INSECURE_HTTP: 'true',
        FRIGATE_USERNAME: 'viewer',
        FRIGATE_PASSWORD: PASSWORD,
        FRIGATE_ARTIFACT_DIR: artifactDir,
      },
      stderr: 'pipe',
    });
    const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    // The resumed run only needs the final answer: the interrupted code-mode
    // task reruns from its journal, so the model is not asked for a new
    // script.
    faux.setResponses([fauxAssistantMessage('Deterministic recovery investigation finished.')]);
    const registry = createRegistry();
    registry.install(bridge.extension);
    registry.install(createCodemodeExtension({ sandbox, models: false, namespaces: [frigateNamespace] }));
    const context = BACKGROUND_CONTEXT;
    const harness = await Harness.open(storage, { models, registry }, context);
    try {
      harness.resume();
      const submission = await harness.submission(submissionId as never, context);
      assert.ok(submission, 'the pending submission must be reacquired after the restart');
      const settled = await submission.wait(context);
      assert.equal(settled.status, 'done');
      const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
      const messages = await root.context(context).then(value => value.messages);
      const result = messages.find(message => message.role === 'toolResult' && message.toolName === 'codemode');
      assert.ok(result && result.role === 'toolResult');
      const output = result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
      assert.match(output, /"authorizedApiAccess":"confirmed"/);
      assert.match(output, /"cameras":2/);

      // The committed observation is reused; the interrupted safe read repeats.
      assert.equal(
        fixture.requests.filter(request => request.path.endsWith('/stats')).length,
        statusRequests,
        'a committed nested result must not be issued again',
      );
      assert.equal(
        fixture.requests.filter(request => request.path.endsWith('/config')).length,
        configRequests + 1,
        'an interrupted replay-safe read may run again',
      );
    } finally {
      await harness.close(context);
      await sandbox.close();
      await bridge.close();
    }

    // No credential is persisted in the durable storage.
    const raw = await readFile(storagePath);
    assert.doesNotMatch(raw.toString('latin1'), new RegExp(PASSWORD));
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('an expired artifact reference fails explicitly after a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'frigate-mcp-recovery-'));
  const artifactDir = join(directory, 'artifacts');
  const fixture = await startFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    clips: { bytes: Buffer.from('CLIP'.repeat(16)) },
  });
  try {
    // Publish an artifact with a short lifetime, then close the server.
    const first = new Client({ name: 'test', version: '1' });
    let uri = '';
    try {
      await first.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, {
        FRIGATE_USERNAME: 'viewer',
        FRIGATE_PASSWORD: PASSWORD,
        FRIGATE_ARTIFACT_DIR: artifactDir,
        FRIGATE_ARTIFACT_TTL_SECONDS: '1',
      })));
      const clip = await first.callTool({ name: 'get_event_clip', arguments: { eventId: '1700000000.100000' } });
      assert.equal(clip.isError, false);
      uri = (clip.structuredContent as { data: { uri: string } }).data.uri;
    } finally { await first.close(); }

    // A restarted server still knows the artifact, but it has expired.
    await new Promise(resolve => setTimeout(resolve, 1200));
    const second = new Client({ name: 'test', version: '1' });
    try {
      await second.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, {
        FRIGATE_USERNAME: 'viewer',
        FRIGATE_PASSWORD: PASSWORD,
        FRIGATE_ARTIFACT_DIR: artifactDir,
        FRIGATE_ARTIFACT_TTL_SECONDS: '1',
      })));
      await assert.rejects(second.readResource({ uri }), /expired/i);
    } finally { await second.close(); }
  } finally {
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('the bridge refuses a changed callable manifest after a restart', async () => {
  await assert.rejects(connectFrigateStdio({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('./helpers/changed-manifest-server.ts', import.meta.url))],
    stderr: 'pipe',
  }), /Unable to connect to a compatible Frigate MCP server/);
});
