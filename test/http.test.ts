import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startFrigateHttpServer } from '../src/server-http.js';
import { connectFrigateHttp } from '../src/durable.js';
import { startFixture, type FixtureOptions } from './helpers/fixture.js';
import { runScriptOverHttp } from './helpers/durable.js';

const SECRET = 'a-very-high-entropy-mcp-secret-value-0123456789';
const PASSWORD = 'sup3r-secret-password';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  const port = address && typeof address !== 'string' ? address.port : 0;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

async function withServer(options: FixtureOptions, run: (context: { url: string; requests: unknown[] }) => Promise<void>) {
  const fixture = await startFixture(options);
  const port = await freePort();
  const server = await startFrigateHttpServer({
    apiRoot: fixture.apiRoot,
    allowInsecureHttp: true,
    username: 'viewer',
    password: PASSWORD,
    secret: SECRET,
    cameras: ['front'],
    port,
    allowedOrigins: [`http://127.0.0.1:${port}`],
  });
  try {
    await run({ url: server.url, requests: fixture.requests });
  } finally {
    await server.close();
    await fixture.close();
  }
}

function httpClient(url: string, secret?: string) {
  return new StreamableHTTPClientTransport(new URL(url), {
    requestInit: secret ? { headers: { authorization: `Bearer ${secret}` } } : {},
  });
}

test('a remote client runs the same read-only investigation over Streamable HTTP', async () => {
  await withServer({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async ({ url }) => {
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(httpClient(url, SECRET));
      const { tools } = await client.listTools();
      assert.ok(tools.some(tool => tool.name === 'get_system_status'));
      const status = await client.callTool({ name: 'get_system_status', arguments: {} });
      assert.equal(status.isError, false);
      const structured = status.structuredContent as { ok: boolean; data: { authorizedApiAccess: string } };
      assert.equal(structured.data.authorizedApiAccess, 'confirmed');
    } finally { await client.close(); }
  });
});

test('the durable bridge connects to the remote server without changing tool contracts', async () => {
  await withServer({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async ({ url }) => {
    const bridge = await connectFrigateHttp({ url, secret: SECRET });
    try {
      const tool = (bridge.extension.tools ?? []).find((entry: { name: string }) => entry.name === 'mcp__frigate__get_system_status');
      assert.ok(tool, 'the bridge must register the same tools over HTTP');
      const result = await tool.execute({}, {} as never, {} as never);
      const structured = result.structuredOutput as { structuredContent: { ok: boolean } };
      assert.equal(structured.structuredContent.ok, true);
    } finally { await bridge.close(); }
  });
});

test('unauthenticated and wrong-secret calls are refused', async () => {
  await withServer({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async ({ url }) => {
    for (const secret of [undefined, 'wrong-secret-value-that-is-long-enough-to-pass']) {
      const client = new Client({ name: 'test', version: '1' });
      try {
        await assert.rejects(client.connect(httpClient(url, secret)), /Unauthorized|401|Error/);
      } finally { await client.close(); }
      }
  });
});

test('a hostile Origin is rejected and artifacts stay behind authentication', async () => {
  await withServer({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async ({ url }) => {
    const origin = new URL(url).origin;
    const hostile = await fetch(`${url.replace('/mcp', '')}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, origin: 'https://attacker.invalid', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(hostile.status, 403);
    // The same client from an allowed origin is accepted.
    const allowed = new Client({ name: 'test', version: '1' });
    try {
      await allowed.connect(new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${SECRET}`, origin } },
      }));
      const { tools } = await allowed.listTools();
      assert.ok(tools.length > 0);
    } finally { await allowed.close(); }
    // Without the secret, even a resource read is refused.
    const unauthenticated = await fetch(`${url.replace('/mcp', '')}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'frigate://artifact/00000000000000000000000000000000' } }),
    });
    assert.equal(unauthenticated.status, 401);
  });
});

test('an oversized request body is refused', async () => {
  await withServer({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async ({ url }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { padding: 'x'.repeat(2 * 1024 * 1024) } }),
    });
    assert.equal(response.status, 413);
  });
});

test('an unknown session and a wrong path are refused with sanitized answers', async () => {
  await withServer({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async ({ url }) => {
    const wrongPath = await fetch(url.replace('/mcp', '/other'), {
      method: 'POST',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(wrongPath.status, 404);
    const unknownSession = await fetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${SECRET}`, 'mcp-session-id': '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(unknownSession.status, 404);
  });
});

test('the code-mode investigation runs over the remote transport with the same scope rules', async () => {
  await withServer({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async ({ url }) => {
    const run = await runScriptOverHttp(url, SECRET, `
const cameras = await tools.mcp__frigate__list_cameras({});
const forbidden = await tools.mcp__frigate__list_cameras({camera: 'back'});
const status = await tools.mcp__frigate__get_system_status({});
text({
  cameras: cameras.structuredContent.data.cameras.length,
  forbidden: forbidden.structuredContent.error.code,
  authorized: status.structuredContent.data.authorizedApiAccess,
});
`);
    assert.equal(run.result.isError, false, JSON.stringify(run.result));
    const output = run.result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
    assert.match(output, /"cameras":1/);
    assert.match(output, /"forbidden":"forbidden"/);
    assert.match(output, /"authorized":"confirmed"/);
  });
});
