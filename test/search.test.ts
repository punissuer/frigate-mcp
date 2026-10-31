import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture, type FixtureOptions } from './helpers/fixture.js';
import { runScript, serverParameters } from './helpers/durable.js';

const PASSWORD = 'sup3r-secret-password';
const AFTER = 1_699_999_000;
const BEFORE = 1_700_002_500;
const credentials = { user: 'viewer', password: PASSWORD };
const authEnv = { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD };

const matches = [
  {
    id: '1700000000.100000', camera: 'front', label: 'person', sub_label: 'adult', zones: ['porch'],
    start_time: 1700000000.1, end_time: 1700000010.25, has_clip: true, has_snapshot: true,
    data: { score: 0.92, average_estimated_speed: 1.4, description: 'SECRET person description' },
    search_distance: 0.12, search_source: 'description',
  },
  {
    id: '1700000100.200000', camera: 'front', label: 'car', sub_label: null, zones: ['driveway'],
    start_time: 1700000100.2, end_time: 1700000105.5, has_clip: false, has_snapshot: true,
    data: { score: 0.75, average_estimated_speed: 3.2, description: 'SECRET car description' },
    search_distance: 0.34, search_source: 'thumbnail',
  },
];

function text(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

async function withFixture(options: FixtureOptions, run: (fixture: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const fixture = await startFixture(options);
  try { await run(fixture); } finally { await fixture.close(); }
}

test('code mode searches semantically, inspects a match, and summarizes relevant fields', async () => {
  await withFixture({ requireAuth: true, credentials, semanticSearch: { enabled: true, matches } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const search = await tools.mcp__frigate__search_events({query: 'person near the porch', after: ${AFTER}, before: ${BEFORE}});
if (search.isError || !search.structuredContent.ok) throw new Error('Search failed');
const match = search.structuredContent.data.events[0];
const detail = await tools.mcp__frigate__get_event({eventId: match.id});
if (detail.isError || !detail.structuredContent.ok) throw new Error('Event detail failed');
text({
  capability: search.structuredContent.data.capability,
  complete: search.structuredContent.data.completeness.complete,
  match,
  detail: detail.structuredContent.data.event,
});
`, { env: authEnv });
    assert.equal(run.result.isError, false, text(run.result));
    const output = text(run.result);
    assert.match(output, /"capability":"supported"/);
    assert.match(output, /"complete":true/);
    assert.match(output, /"id":"1700000000\.100000"/);
    assert.match(output, /"searchDistance":0\.12/);
    assert.match(output, /"searchSource":"description"/);
    assert.doesNotMatch(output, /SECRET|description":"/);
    const request = fixture.requests.find(entry => entry.path.startsWith('/nvr/api/events/search?'));
    assert.ok(request, 'the search endpoint must be requested');
    const query = new URL(request.path, 'http://fixture.invalid').searchParams;
    assert.equal(query.get('query'), 'person near the porch');
    assert.equal(query.get('search_type'), 'thumbnail');
    assert.equal(query.get('sort'), 'relevance');
    assert.equal(query.get('include_thumbnails'), '0');
    assert.equal(query.get('after'), String(AFTER));
    assert.equal(query.get('before'), String(BEFORE));
  });
});

test('a disabled semantic search service is reported precisely and the script falls back to filters', async () => {
  await withFixture({ requireAuth: true, credentials, semanticSearch: { enabled: false } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const search = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER}, before: ${BEFORE}});
const fallback = await tools.mcp__frigate__list_events({after: ${AFTER}, before: ${BEFORE}, labels: ['person']});
text({
  searchError: search.structuredContent.error,
  capability: search.structuredContent.data.capability,
  warnings: search.structuredContent.meta.warnings,
  fallbackCount: fallback.structuredContent.data.events.length,
});
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"code":"feature_disabled"/);
    assert.match(output, /"capability":"disabled"/);
    assert.match(output, /fall back to list_events/);
    assert.match(output, /"fallbackCount":2/);
  });
});

test('a release without the search endpoint reports the feature as unsupported', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/events/search')) return false;
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ message: 'Not found' }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const search = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER}, before: ${BEFORE}});
text(search);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"code":"feature_unsupported"/);
    assert.match(output, /"capability":"unsupported"/);
  });
});

test('camera scope rejects forbidden search filters and drops forbidden results', async () => {
  await withFixture({ requireAuth: true, credentials, semanticSearch: { enabled: true, matches } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const forbidden = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER}, before: ${BEFORE}, cameras: ['back']});
const scoped = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER}, before: ${BEFORE}});
text({forbidden, scoped});
`, { env: { ...authEnv, FRIGATE_CAMERAS: 'front' } });
    const output = text(run.result);
    assert.match(output, /"code":"forbidden"/);
    assert.doesNotMatch(output, /"camera":"back"/);
    const request = fixture.requests.find(entry => entry.path.startsWith('/nvr/api/events/search?'));
    assert.ok(request);
    assert.equal(new URL(request.path, 'http://fixture.invalid').searchParams.get('cameras'), 'front');
  });
});

test('an empty search is an empty success and not a failure', async () => {
  await withFixture({ requireAuth: true, credentials, semanticSearch: { enabled: true, matches: [] } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const search = await tools.mcp__frigate__search_events({query: 'nothing matches', after: ${AFTER}, before: ${BEFORE}});
text(search);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"ok":true/);
    assert.match(output, /"events":\[\]/);
    assert.match(output, /"capability":"supported"/);
  });
});

test('malformed upstream search data fails without echoing its body', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    semanticSearch: { enabled: true },
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/events/search')) return false;
      res.setHeader('content-type', 'application/json');
      res.end('{"matches": SECRET');
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const search = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER}, before: ${BEFORE}});
text(search);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"malformed_response"/);
    assert.doesNotMatch(text(run.result), /SECRET/);
  });
});

test('a transient search failure is retried within the deadline', async () => {
  let attempts = 0;
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/events/search')) return false;
      attempts++;
      if (attempts === 1) {
        res.writeHead(503, { 'content-type': 'application/json' }).end('{"message":"busy"}');
        return true;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(matches));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const search = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER}, before: ${BEFORE}});
text(search);
`, { env: authEnv });
    assert.match(text(run.result), /"capability":"supported"/);
    assert.equal(attempts, 2);
  });
});

test('a truncated search reports incompleteness instead of exhaustive coverage', async () => {
  await withFixture({ requireAuth: true, credentials, semanticSearch: { enabled: true, matches } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const search = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER}, before: ${BEFORE}, limit: 1});
text(search);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"complete":false/);
    assert.match(output, /"truncated":true/);
    assert.match(output, /"nextOffset":1/);
    assert.match(output, /more matches may exist/);
  });
});

test('invalid intervals and an empty query are rejected before any upstream request', async () => {
  await withFixture({ requireAuth: true, credentials, semanticSearch: { enabled: true, matches } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const units = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER * 1000}, before: ${BEFORE * 1000}});
const window = await tools.mcp__frigate__search_events({query: 'person', after: ${AFTER}, before: ${AFTER + 90000}});
text({units, window});
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"code":"invalid_request"/);
    assert.match(output, /Unix seconds/);
    assert.match(output, /maximum window/);
    assert.equal(fixture.requests.filter(entry => entry.path.startsWith('/nvr/api/events/search')).length, 0);
  });

  const client = new Client({ name: 'test', version: '1' });
  const fixture = await startFixture({ requireAuth: true, credentials, semanticSearch: { enabled: true, matches } });
  try {
    await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, authEnv)));
    const result = await client.callTool({ name: 'search_events', arguments: { query: '', after: AFTER, before: BEFORE } });
    assert.equal(result.isError, true, 'an empty query must be rejected');
    assert.equal(fixture.requests.filter(entry => entry.path.startsWith('/nvr/api/events/search')).length, 0);
  } finally { await client.close(); await fixture.close(); }
});
