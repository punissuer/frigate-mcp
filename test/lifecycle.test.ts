import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFrigateServer } from '../src/server.js';
import { connectFrigateStdio } from '../src/durable.js';
import { serverParameters } from './helpers/durable.js';
import { startFixture } from './helpers/fixture.js';

test('bridge refuses an incompatible/destructive manifest and closes its client', async () => {
  await assert.rejects(connectFrigateStdio({
    command: process.execPath,
    args: ['--import', 'tsx', fileURLToPath(new URL('./helpers/incompatible-server.ts', import.meta.url))],
    stderr: 'pipe',
  }), /Unable to connect to a compatible Frigate MCP server/);
});

test('MCP cancellation aborts the in-flight upstream body and releases concurrency', async () => {
  let started!: () => void;
  let closed!: () => void;
  const bodyStarted = new Promise<void>(resolve => { started = resolve; });
  const bodyClosed = new Promise<void>(resolve => { closed = resolve; });
  let stall = true;
  const fixture = await startFixture((req, res) => {
    if (!stall || !req.url?.endsWith('/stats')) return false;
    res.on('close', closed);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{'); started(); return true;
  });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, { FRIGATE_MAX_CONCURRENT: '1' })));
    const controller = new AbortController();
    const request = client.callTool({ name: 'get_system_status', arguments: {} }, undefined, { signal: controller.signal });
    const rejected = assert.rejects(request);
    await bodyStarted;
    controller.abort();
    await rejected;
    await Promise.race([bodyClosed, delay(2000).then(() => { throw new Error('Upstream body not cancelled'); })]);
    stall = false;
    // The server must finish the cancelled request's cleanup before admitting another.
    let result;
    for (let attempt = 0; attempt < 20; attempt++) {
      result = await client.callTool({ name: 'get_system_status', arguments: {} });
      if (!result.isError) break;
      await delay(10);
    }
    assert.equal(result?.isError, false);
  } finally { await client.close(); await fixture.close(); }
});

test('CLI refuses unsafe configuration without echoing secrets or contaminating stdout', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url))], {
    env: { FRIGATE_API_ROOT: 'https://user:SECRET@localhost/api' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /startup failed/);
  assert.doesNotMatch(stderr, /SECRET|user:/);
});

test('public server constructor rejects insecure or unbounded configuration', () => {
  for (const options of [
    { apiRoot: 'http://localhost/api' },
    { apiRoot: 'file:///etc/passwd' },
    { apiRoot: 'https://localhost/api?token=SECRET' },
    { apiRoot: 'https://localhost/api', bearerToken: 'bad\ntoken' },
    { apiRoot: 'https://localhost/api', maxResponseBytes: Infinity },
    { apiRoot: 'https://localhost/api', timeoutMs: 0 },
    { apiRoot: 'https://localhost/api', maxConcurrent: 1.5 },
  ]) assert.throws(() => createFrigateServer(options));
});
