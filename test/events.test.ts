import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture, type FixtureOptions } from './helpers/fixture.js';
import { runScript, serverParameters } from './helpers/durable.js';

const PASSWORD = 'sup3r-secret-password';
const AFTER = 1_699_999_000;
const BEFORE = 1_700_002_500;

function text(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

async function withFixture(options: FixtureOptions, run: (fixture: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const fixture = await startFixture(options);
  try { await run(fixture); } finally { await fixture.close(); }
}

const credentials = { user: 'viewer', password: PASSWORD };
const authEnv = { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD };

test('code mode filters events, retrieves one by ID, and emits a compact evidence summary', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const namespace = await describeNamespace('frigate');
if (!namespace.tools.includes('mcp__frigate__list_events')) throw new Error('Missing list_events');
if (!namespace.tools.includes('mcp__frigate__get_event')) throw new Error('Missing get_event');
const list = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}, cameras: ['front'], labels: ['person']});
if (list.isError || !list.structuredContent.ok) throw new Error('Event listing failed');
const events = list.structuredContent.data.events;
const detail = await tools.mcp__frigate__get_event({eventId: events[0].id});
if (detail.isError || !detail.structuredContent.ok) throw new Error('Event detail failed');
text({
  summary: {
    count: events.length,
    complete: list.structuredContent.data.completeness.complete,
    first: events[0],
  },
  detail: detail.structuredContent.data.event,
});
`, { env: authEnv });
    assert.equal(run.result.isError, false, text(run.result));
    const output = text(run.result);
    assert.match(output, /"id":"1700000000\.100000"/);
    assert.match(output, /"camera":"front"/);
    assert.match(output, /"label":"person"/);
    assert.match(output, /"hasClip":true/);
    assert.match(output, /"complete":true/);
    assert.doesNotMatch(output, /SECRET|description|thumbnail/);
    const request = fixture.requests.find(entry => entry.path.startsWith('/nvr/api/events?'));
    assert.ok(request, 'the events endpoint must be requested');
    const query = new URL(request.path, 'http://fixture.invalid').searchParams;
    assert.equal(query.get('after'), String(AFTER));
    assert.equal(query.get('before'), String(BEFORE));
    assert.equal(query.get('cameras'), 'front');
    assert.equal(query.get('labels'), 'person');
    assert.equal(query.get('limit'), '50');
    assert.equal(query.get('offset'), '0');
    assert.equal(query.get('include_thumbnails'), '0');
    assert.equal(query.get('sort'), 'date_desc');
    assert.ok(fixture.requests.some(entry => entry.path === '/nvr/api/events/1700000000.100000'));
  });
});

test('millisecond timestamps are rejected with an actionable units error', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER * 1000}, before: ${BEFORE * 1000}});
text(result);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"invalid_request"/);
    assert.match(text(run.result), /Unix seconds/);
    assert.equal(fixture.requests.filter(entry => entry.path.startsWith('/nvr/api/events')).length, 0);
  });
});

test('reversed and oversized intervals are rejected before any upstream request', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const reversed = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${BEFORE}, before: ${AFTER}});
text(result);
`, { env: authEnv });
    assert.match(text(reversed.result), /"code":"invalid_request"/);
    const oversized = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${AFTER + 90000}});
text(result);
`, { env: authEnv });
    assert.match(text(oversized.result), /"code":"invalid_request"/);
    assert.match(text(oversized.result), /maximum window/);
    assert.equal(fixture.requests.filter(entry => entry.path.startsWith('/nvr/api/events')).length, 0);
  });
});

test('camera scope rejects forbidden filters and direct lookups without leaking metadata', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const forbiddenList = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}, cameras: ['back']});
const forbiddenEvent = await tools.mcp__frigate__get_event({eventId: '1700000200.300000'});
text({forbiddenList, forbiddenEvent});
`, { env: { ...authEnv, FRIGATE_CAMERAS: 'front' } });
    const output = text(run.result);
    assert.match(output, /"code":"forbidden"/);
    assert.doesNotMatch(output, /1700000200\.300000|"camera":"back"|SECRET/);
    // A forbidden filter never reaches the upstream, and a forbidden direct
    // lookup never returns the event's metadata.
    assert.equal(fixture.requests.filter(entry => entry.path.startsWith('/nvr/api/events?')).length, 0);
  });
});

test('a truncated page reports incompleteness and a continuation offset', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}, limit: 1});
text(result);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"complete":false/);
    assert.match(output, /"truncated":true/);
    assert.match(output, /"nextOffset":1/);
    assert.match(output, /more events may exist/);
  });
});

test('duplicate event identifiers are removed from a page', async () => {
  const duplicated = [
    { id: '1700000000.100000', camera: 'front', label: 'person', zones: [], start_time: AFTER + 10, end_time: AFTER + 20, has_clip: true, has_snapshot: true, data: { score: 0.5 } },
    { id: '1700000000.100000', camera: 'front', label: 'person', zones: [], start_time: AFTER + 10, end_time: AFTER + 20, has_clip: true, has_snapshot: true, data: { score: 0.5 } },
  ];
  await withFixture({ requireAuth: true, credentials, events: duplicated }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: authEnv });
    assert.match(text(run.result), /"returned":1/);
  });
});

test('an empty interval is an empty success, not an error', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${AFTER + 10}});
text(result);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"ok":true/);
    assert.match(output, /"events":\[\]/);
    assert.match(output, /"returned":0/);
  });
});

test('a missing event is reported as not found', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_event({eventId: '1699999999.999999'});
text(result);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"not_found"/);
  });
});

test('role denial on the events endpoint stays a structured forbidden error', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/events')) return false;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Access denied. A user with the admin role is required.' }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"forbidden"/);
    assert.doesNotMatch(text(run.result), /admin role is required/);
  });
});

test('malformed and oversized event responses fail without echoing their body', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/events?')) return false;
      res.setHeader('content-type', 'application/json');
      res.end('{"secret": SECRET');
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"malformed_response"/);
    assert.doesNotMatch(text(run.result), /SECRET/);
  });

  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/events?')) return false;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ events: 'x'.repeat(4096) }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: { ...authEnv, FRIGATE_MAX_RESPONSE_BYTES: '512' } });
    assert.match(text(run.result), /"code":"payload_too_large"/);
  });
});

test('event identifiers cannot escape the events route', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, authEnv)));
      for (const eventId of ['../stats', 'a/b', '..']) {
        const result = await client.callTool({ name: 'get_event', arguments: { eventId } });
        assert.equal(result.isError, true, `expected ${eventId} to be rejected`);
      }
      assert.equal(fixture.requests.filter(entry => entry.path.includes('stats')).length, 0);
    } finally { await client.close(); }
  });
});

test('events with equal timestamps keep unique identifiers within a page', async () => {
  const equal = [
    { id: '1700000000.100000', camera: 'front', label: 'person', zones: [], start_time: AFTER + 10, end_time: AFTER + 20, has_clip: true, has_snapshot: true, data: { score: 0.5 } },
    { id: '1700000000.200000', camera: 'front', label: 'person', zones: [], start_time: AFTER + 10, end_time: AFTER + 20, has_clip: true, has_snapshot: true, data: { score: 0.5 } },
    { id: '1700000000.300000', camera: 'front', label: 'person', zones: [], start_time: AFTER + 10, end_time: AFTER + 20, has_clip: true, has_snapshot: true, data: { score: 0.5 } },
  ];
  await withFixture({ requireAuth: true, credentials, events: equal }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"returned":3/);
    const identifiers = [...output.matchAll(/"id":"([^"]+)"/g)].map(match => match[1]);
    assert.equal(new Set(identifiers).size, identifiers.length);
  });
});

test('a later page reports that a live dataset can shift between pages', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}, offset: 1});
text(result);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /live dataset can shift/);
    assert.match(output, /"offset":1/);
  });
});

test('a short page is complete and never invents a continuation cursor', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}, limit: 50});
text(result);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"complete":true/);
    assert.match(output, /"truncated":false/);
    assert.doesNotMatch(output, /nextOffset/);
  });
});

test('operator policy caps the page size and the historical window', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${AFTER + 3600}, limit: 200});
text(result);
`, { env: { ...authEnv, FRIGATE_EVENTS_PAGE_SIZE: '10', FRIGATE_EVENTS_MAX_WINDOW_SECONDS: '600' } });
    const output = text(run.result);
    assert.match(output, /"code":"invalid_request"/);
    assert.match(output, /600 second maximum window/);
    assert.equal(fixture.requests.length, 0, 'an invalid interval must not reach the upstream');
  });
});
