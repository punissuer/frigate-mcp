import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFrigateServer } from '../src/server.js';
import { startFixture, type FixtureOptions } from './helpers/fixture.js';
import { runScript, serverParameters } from './helpers/durable.js';

const PASSWORD = 'sup3r-secret-password';

function text(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

async function withFixture(options: FixtureOptions, run: (fixture: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const fixture = await startFixture(options);
  try { await run(fixture); } finally { await fixture.close(); }
}

const discoveryScript = `
const ns = await describeNamespace('frigate');
const names = ns.tools;
if (!names.includes('mcp__frigate__list_cameras')) throw new Error('Missing list_cameras');
if (!names.includes('mcp__frigate__get_capabilities')) throw new Error('Missing get_capabilities');
const cameras = await tools.mcp__frigate__list_cameras({});
const capabilities = await tools.mcp__frigate__get_capabilities({});
text({cameras, capabilities});
`;

test('code mode discovers permitted cameras, zones, labels and capabilities without leaking configuration', async () => {
  await withFixture({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async fixture => {
    const run = await runScript(fixture.apiRoot, discoveryScript, {
      env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD },
    });
    assert.equal(run.result.isError, false, text(run.result));
    const output = text(run.result);
    assert.match(output, /"id":"front"/);
    assert.match(output, /"id":"back"/);
    assert.match(output, /"zones":\["porch","driveway"\]/);
    assert.match(output, /"detectionEnabled":true/);
    assert.match(output, /"trackedLabels":\["car","person"\]/);
    assert.match(output, /"objectEvents":"supported"/);
    assert.match(output, /"semanticSearch":"unknown"/);
    assert.match(output, /"cameraScope":"unrestricted"/);
    assert.doesNotMatch(output, /SECRET|PRIVATE|rtsp:|api_key|environment_vars|mqtt/);
    assert.doesNotMatch(output, new RegExp(PASSWORD));
    assert.ok(fixture.requests.some(request => request.path === '/nvr/api/config'));
    assert.ok(fixture.requests.some(request => request.path === '/nvr/api/login' && request.method === 'POST'));
  });
});

test('managed login keeps the password out of every upstream request except the login body', async () => {
  await withFixture({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async fixture => {
    const run = await runScript(fixture.apiRoot, discoveryScript, {
      env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD },
    });
    assert.equal(run.result.isError, false, text(run.result));
    const logins = fixture.requests.filter(request => request.path === '/nvr/api/login');
    assert.equal(logins.length, 1);
    for (const request of fixture.requests) {
      assert.ok(!(request.authorization ?? '').includes(PASSWORD));
      assert.ok(!(request.cookie ?? '').includes(PASSWORD));
    }
    // The session is carried by the configured cookie, never by the password.
    const config = fixture.requests.find(request => request.path === '/nvr/api/config');
    assert.match(config?.cookie ?? '', /frigate_token=/);
  });
});

test('an expired external bearer token fails actionably without a refresh loop', async () => {
  await withFixture({ requireAuth: true }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_system_status({});
text(result);
`, { env: { FRIGATE_BEARER_TOKEN: 'STALE_TOKEN' } });
    const output = text(run.result);
    assert.match(output, /"code":"authentication"/);
    assert.match(output, /bearer token/);
    assert.equal(fixture.requests.filter(request => request.path === '/nvr/api/stats').length, 1, 'an external token is never retried');
    assert.equal(fixture.requests.filter(request => request.path === '/nvr/api/login').length, 0);
  });
});

test('rejected credentials fail actionably without repeated login attempts', async () => {
  await withFixture({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: 'wrong-password-value' } });
    const output = text(run.result);
    assert.match(output, /"code":"authentication"/);
    assert.match(output, /rejected the configured credentials/);
    assert.doesNotMatch(output, /wrong-password-value/);
    assert.equal(fixture.requests.filter(request => request.path === '/nvr/api/login').length, 1, 'bad credentials must not loop');
  });
});

test('a revoked session re-authenticates at most once per read', async () => {
  await withFixture({ requireAuth: true, expireSessions: true, credentials: { user: 'viewer', password: PASSWORD } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD } });
    const output = text(run.result);
    assert.match(output, /"code":"authentication"/);
    const logins = fixture.requests.filter(request => request.path === '/nvr/api/login').length;
    const configs = fixture.requests.filter(request => request.path === '/nvr/api/config').length;
    assert.ok(logins <= 2, `expected at most two logins, saw ${logins}`);
    assert.ok(configs <= 2, `expected at most two configuration reads, saw ${configs}`);
  });
});

test('concurrent reads share a single serialized session refresh', async () => {
  await withFixture({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const results = await Promise.all([
  tools.mcp__frigate__list_cameras({}),
  tools.mcp__frigate__get_capabilities({}),
  tools.mcp__frigate__list_cameras({}),
]);
text(results.map(result => result.structuredContent.ok));
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD, FRIGATE_MAX_CONCURRENT: '4' } });
    assert.equal(run.result.isError, false, text(run.result));
    assert.match(text(run.result), /\[true,true,true\]/);
    assert.equal(fixture.requests.filter(request => request.path === '/nvr/api/login').length, 1, 'session refresh must be serialized');
  });
});

test('camera scope restricts discovery and statistics and rejects forbidden cameras', async () => {
  await withFixture({ requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const cameras = await tools.mcp__frigate__list_cameras({});
const forbidden = await tools.mcp__frigate__list_cameras({camera: 'back'});
const status = await tools.mcp__frigate__get_system_status({});
text({cameras, forbidden, status});
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD, FRIGATE_CAMERAS: 'front' } });
    const output = text(run.result);
    assert.match(output, /"scope":"restricted"/);
    assert.match(output, /"id":"front"/);
    assert.doesNotMatch(output, /"id":"back"/);
    assert.match(output, /"code":"forbidden"/);
    assert.match(output, /outside the configured scope/);
    // Unscopable aggregates are omitted instead of leaking the wider scope.
    assert.match(output, /"detectors":\{\}/);
  });
});

test('role denial on the configuration endpoint returns a structured forbidden error', async () => {
  await withFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    override: (req, res) => {
      if (!req.url?.endsWith('/config')) return false;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Access denied. A user with the admin role is required.' }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD } });
    const output = text(run.result);
    assert.match(output, /"code":"forbidden"/);
    assert.doesNotMatch(output, /admin role is required/);
  });
});

test('malformed and oversized configuration responses fail without echoing their body', async () => {
  await withFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    override: (req, res) => {
      if (!req.url?.endsWith('/config')) return false;
      res.setHeader('content-type', 'application/json');
      res.end('{"cameras": SECRET');
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD } });
    assert.match(text(run.result), /"code":"malformed_response"/);
    assert.doesNotMatch(text(run.result), /SECRET/);
  });

  await withFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    override: (req, res) => {
      if (!req.url?.endsWith('/config')) return false;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ cameras: {}, filler: 'x'.repeat(4096) }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD, FRIGATE_MAX_RESPONSE_BYTES: '512' } });
    assert.match(text(run.result), /"code":"payload_too_large"/);
  });
});

test('a redirect on the configuration endpoint is rejected without following it', async () => {
  await withFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    override: (req, res) => {
      if (!req.url?.endsWith('/config')) return false;
      res.writeHead(302, { location: 'http://attacker.invalid/SECRET' }).end('SECRET');
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD } });
    assert.match(text(run.result), /"code":"redirect_rejected"/);
    assert.doesNotMatch(text(run.result), /attacker|SECRET/);
  });
});

test('transient failures are retried with bounded Retry-After handling', async () => {
  let attempts = 0;
  await withFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    override: (req, res) => {
      if (!req.url?.endsWith('/config')) return false;
      attempts++;
      if (attempts === 1) {
        res.writeHead(429, { 'retry-after': '0', 'content-type': 'application/json' }).end('{"message":"slow down"}');
        return true;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ cameras: { front: { zones: {}, detect: { enabled: true } } }, tracked_objects: [{ label: 'person' }] }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD } });
    assert.match(text(run.result), /"id":"front"/);
    assert.equal(attempts, 2, 'a transient failure is retried once and then succeeds');
  });
});

test('cancellation aborts an in-flight configuration read', async () => {
  await withFixture({
    requireAuth: true,
    credentials: { user: 'viewer', password: PASSWORD },
    override: (req, res) => {
      if (!req.url?.endsWith('/config')) return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      return true;
    },
  }, async fixture => {
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, {
        FRIGATE_USERNAME: 'viewer',
        FRIGATE_PASSWORD: PASSWORD,
      })));
      const controller = new AbortController();
      const request = client.callTool({ name: 'list_cameras', arguments: {} }, undefined, { signal: controller.signal });
      const rejected = assert.rejects(request);
      await delay(200);
      controller.abort();
      await rejected;
    } finally { await client.close(); }
  });
});

test('a custom CA is required to reach a private TLS deployment', async t => {
  let directory: string;
  try {
    directory = mkdtempSync(join(tmpdir(), 'frigate-mcp-tls-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { stdio: 'ignore' });
  } catch {
    t.skip('openssl is unavailable in this environment');
    return;
  }
  const key = readFileSync(join(directory, 'key.pem'));
  const cert = readFileSync(join(directory, 'cert.pem'));
  await withFixture({ tls: { key, cert }, requireAuth: true, credentials: { user: 'viewer', password: PASSWORD } }, async fixture => {
    const untrusted = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, { env: { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD } });
    assert.match(text(untrusted.result), /"code":"unreachable"/);

    const trusted = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_cameras({});
text(result);
`, {
      env: {
        FRIGATE_USERNAME: 'viewer',
        FRIGATE_PASSWORD: PASSWORD,
        FRIGATE_CA_CERT_FILE: join(directory, 'cert.pem'),
      },
    });
    assert.match(text(trusted.result), /"id":"front"/);
  });
});

test('operator configuration rejects unsafe camera scopes and credential combinations', () => {
  for (const options of [
    { apiRoot: 'https://localhost/api', username: 'viewer' },
    { apiRoot: 'https://localhost/api', password: 'secret' },
    { apiRoot: 'https://localhost/api', cameras: ['../etc/passwd'] },
    { apiRoot: 'https://localhost/api', cameras: ['front', 'front/../back'] },
    { apiRoot: 'https://localhost:5000/api' },
  ]) assert.throws(() => createFrigateServer(options));
});
