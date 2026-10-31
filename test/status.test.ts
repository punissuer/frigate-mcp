import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { statusManifest, outputSchema, toolManifests } from '../src/contract.js';
import { startFixture, type Override } from './helpers/fixture.js';
import { runScript, serverParameters } from './helpers/durable.js';

const statusScript = `
const ns = await describeNamespace('frigate');
if (!ns || !ns.tools.includes('mcp__frigate__get_system_status')) throw new Error('Missing namespace tool');
const matches = await searchTools('Frigate health status');
if (!matches.some(t => t.name === 'mcp__frigate__get_system_status')) throw new Error('Tool not discoverable');
const description = await describeTool('mcp__frigate__get_system_status');
if (!description) throw new Error('Missing tool schema');
if (typeof process !== 'undefined' || typeof fetch !== 'undefined') throw new Error('Unexpected sandbox access');
const result = await tools.mcp__frigate__get_system_status({});
text(result);
`;
function text(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}
async function withFixture(override: Override | undefined, run: (fixture: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const fixture = await startFixture(override);
  try { await run(fixture); } finally { await fixture.close(); }
}

test('code mode discovers and calls real stdio MCP; returns sanitized status and no model-visible MCP declaration', async () => {
  await withFixture(undefined, async fixture => {
    const run = await runScript(fixture.apiRoot + '///', statusScript, { env: { FRIGATE_BEARER_TOKEN: 'TEST_TOKEN' } });
    assert.equal(run.result.isError, false, text(run.result));
    const output = text(run.result);
    assert.match(output, /"authorizedApiAccess":"confirmed"/);
    assert.match(output, /"compatibility":"supported"/);
    assert.match(output, /"camera_fps":5/);
    assert.doesNotMatch(output, /SECRET|PRIVATE|cmdline|ffmpeg_pid|TEST_TOKEN/);
    assert.deepEqual(run.offered, ['codemode']);
    assert.ok(run.callable.includes('mcp__frigate__get_system_status'));
    assert.deepEqual(fixture.requests.map(r => r.path), ['/nvr/api/', '/nvr/api/version', '/nvr/api/stats']);
    assert.ok(fixture.requests.every(r => r.method === 'GET' && r.authorization === 'Bearer TEST_TOKEN'));
    if (run.pid) assert.throws(() => process.kill(run.pid!, 0), { code: 'ESRCH' });
  });
});

test('conventional MCP client receives bounded schemas, read-only annotations, and mirrored structured result', async () => {
  await withFixture(undefined, async fixture => {
    const client = new Client({ name: 'test', version: '1' });
    const transport = new StdioClientTransport(serverParameters(fixture.apiRoot));
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 14);
      for (const tool of tools) {
        const expected = toolManifests[tool.name as keyof typeof toolManifests];
        assert.ok(expected, `unexpected tool ${tool.name}`);
        assert.deepEqual(tool.inputSchema, expected.inputSchema);
        assert.deepEqual(tool.outputSchema, expected.outputSchema);
        assert.equal(tool.annotations?.readOnlyHint, true);
        assert.equal(tool.annotations?.destructiveHint, false);
      }
      assert.ok(tools.some(tool => tool.name === 'get_system_status'));
      const result = CallToolResultSchema.parse(await client.callTool({ name: 'get_system_status', arguments: {} }));
      assert.equal(result.isError, false);
      assert.equal(result.content[0]?.type, 'text');
      assert.deepEqual(JSON.parse(result.content[0]!.type === 'text' ? result.content[0]!.text : ''), result.structuredContent);
      assert.equal(outputSchema.parse(result.structuredContent).ok, true);
      const invalid = await client.callTool({ name: 'get_system_status', arguments: { url: 'http://evil/' } });
      assert.equal(invalid.isError, true);
      assert.equal(fixture.requests.length, 3, 'invalid args must not make upstream requests');
    } finally { await client.close(); }
  });
});

for (const [status, code, retryable] of [
  [401, 'authentication', false], [403, 'forbidden', false], [404, 'not_found', false],
  [429, 'rate_limit', true], [503, 'upstream_error', true], [302, 'redirect_rejected', false],
] as const) {
  test(`stats ${status} remains a structured code-mode error despite healthy public probes`, async () => {
    await withFixture((req, res) => {
      if (!req.url?.endsWith('/stats')) return false;
      res.writeHead(status, { location: 'http://attacker.invalid/SECRET' }).end('SECRET upstream error');
      return true;
    }, async fixture => {
      const run = await runScript(fixture.apiRoot, statusScript, { env: { FRIGATE_TIMEOUT_MS: '30000' } });
      assert.equal(run.result.isError, false, 'schema tool errors resolve to their envelope inside code mode');
      const output = text(run.result);
      assert.match(output, /"isError":true/);
      assert.match(output, new RegExp(`"code":"${code}"`));
      assert.match(output, new RegExp(`"retryable":${retryable}`));
      assert.match(output, /"health":\{"ok":true,"alive":true\}/);
      assert.match(output, status === 401 || status === 403 ? /"authorizedApiAccess":"denied"/ : /"authorizedApiAccess":"unknown"/);
      assert.doesNotMatch(output, /SECRET|attacker/);
      const expectedRequests = retryable ? 5 : 3;
      assert.equal(fixture.requests.length, expectedRequests, 'only transient failures are retried');
    });
  });
}

for (const [version, compatibility] of [['0.18.2-aabbccd', 'supported'], ['0.17.0', 'unsupported'], ['0.19.0', 'unknown']] as const) {
  test(`reports ${version} compatibility as ${compatibility}, without implying live certification`, async () => {
    await withFixture((req, res) => {
      if (!req.url?.endsWith('/version')) return false;
      res.setHeader('content-type', 'text/plain'); res.end(version); return true;
    }, async fixture => {
      const run = await runScript(fixture.apiRoot, statusScript);
      assert.match(text(run.result), new RegExp(`"compatibility":"${compatibility}"`));
      if (compatibility !== 'supported') assert.match(text(run.result), /contract-tested/);
    });
  });
}

for (const [label, body, mime] of [
  ['malformed JSON', 'SECRET', 'application/json'],
  ['wrong MIME', '<html>SECRET</html>', 'text/html'],
  ['invalid statistics', '{"cameras":[],"detectors":{},"service":{}}', 'application/json'],
] as const) {
  test(`rejects ${label} without echoing its body`, async () => {
    await withFixture((req, res) => {
      if (!req.url?.endsWith('/stats')) return false;
      res.setHeader('content-type', mime); res.end(body); return true;
    }, async fixture => {
      const run = await runScript(fixture.apiRoot, statusScript);
      assert.match(text(run.result), /"code":"malformed_response"/);
      assert.doesNotMatch(text(run.result), /SECRET/);
    });
  });
}

test('enforces response limit on chunked data without Content-Length', async () => {
  await withFixture((req, res) => {
    if (!req.url?.endsWith('/stats')) return false;
    res.setHeader('content-type', 'application/json');
    res.write(' '.repeat(100)); res.end(' '.repeat(200)); return true;
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, statusScript, { env: { FRIGATE_MAX_RESPONSE_BYTES: '256' } });
    assert.match(text(run.result), /"code":"payload_too_large"/);
  });
});

test('whole-status deadline stops a stalled body', async () => {
  await withFixture((req, res) => {
    if (!req.url?.endsWith('/stats')) return false;
    res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return true;
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, statusScript, { env: { FRIGATE_TIMEOUT_MS: '100' } });
    assert.match(text(run.result), /"code":"timeout"/);
  });
});

test('concurrent code-mode calls respect global upstream limit without an unbounded queue', async () => {
  await withFixture((req, res) => {
    if (req.url !== '/nvr/api/') return false;
    setTimeout(() => { res.setHeader('content-type', 'text/plain'); res.end('Frigate is running. Alive and healthy!'); }, 500);
    return true;
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const results = await Promise.all(Array.from({length: 8}, () => tools.mcp__frigate__get_system_status({})));
text(results.map(r => r.structuredContent.ok ? 'ok' : r.structuredContent.error.code));
`, { env: { FRIGATE_MAX_CONCURRENT: '1' } });
    assert.equal(run.result.isError, false, text(run.result));
    assert.match(text(run.result), /\["ok","busy","busy","busy","busy","busy","busy","busy"\]/);
    assert.equal(fixture.requests.length, 3);
  });
});

test('transport failure rejects in the script rather than returning an empty successful status', async () => {
  await withFixture(undefined, async fixture => {
    const run = await runScript(fixture.apiRoot, `
try { await tools.mcp__frigate__get_system_status({}); text('UNEXPECTED_SUCCESS'); }
catch (error) { text({caught: true, message: error.message}); }
`, { beforeSubmit: async pid => { assert.ok(pid); process.kill(pid, 'SIGKILL'); await delay(100); } });
    assert.equal(run.result.isError, false, text(run.result));
    assert.match(text(run.result), /"caught":true/);
    assert.match(text(run.result), /Frigate MCP call failed/);
    assert.doesNotMatch(text(run.result), /UNEXPECTED_SUCCESS/);
    // The killed server may have started the read; it must never have finished it.
    assert.ok(fixture.requests.length <= 2, `unexpected upstream requests: ${fixture.requests.length}`);
  });
});
