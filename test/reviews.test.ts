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

function text(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

async function withFixture(options: FixtureOptions, run: (fixture: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const fixture = await startFixture(options);
  try { await run(fixture); } finally { await fixture.close(); }
}

test('code mode selects an unreviewed alert, inspects it, and reports recordings and gaps', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const reviews = await tools.mcp__frigate__list_review_items({after: ${AFTER}, before: ${BEFORE}, severity: 'alert', reviewed: false});
if (reviews.isError || !reviews.structuredContent.ok) throw new Error('Review listing failed');
const alert = reviews.structuredContent.data.reviews[0];
const detail = await tools.mcp__frigate__get_review_item({reviewId: alert.id});
if (detail.isError || !detail.structuredContent.ok) throw new Error('Review detail failed');
const summary = await tools.mcp__frigate__get_recording_summary({camera: 'front'});
if (summary.isError || !summary.structuredContent.ok) throw new Error('Recording summary failed');
const recordings = await tools.mcp__frigate__list_recordings({camera: 'front', after: ${AFTER}, before: ${BEFORE}});
if (recordings.isError || !recordings.structuredContent.ok) throw new Error('Recording listing failed');
text({
  alert,
  detail: detail.structuredContent.data.review,
  summary: summary.structuredContent.data,
  recordings: recordings.structuredContent.data,
});
`, { env: authEnv });
    assert.equal(run.result.isError, false, text(run.result));
    const output = text(run.result);
    assert.match(output, /"severity":"alert"/);
    assert.match(output, /"reviewed":false/);
    assert.match(output, /"eventReferences":\["1700000000\.100000"\]/);
    assert.match(output, /"startTime":1700000000/);
    assert.match(output, /"scope":"all_recorded_days"/);
    assert.match(output, /"intervals":\[/);
    assert.match(output, /"gaps":\[/);
    assert.doesNotMatch(output, /thumb_path|"zones"|SECRET/);
    // Nothing may be mutated: only the session login may be a POST.
    const mutations = fixture.requests.filter(request =>
      request.method !== 'GET' && !(request.method === 'POST' && request.path === '/nvr/api/login'));
    assert.deepEqual(mutations, []);
    assert.ok(fixture.requests.every(request => !request.path.includes('/viewed')));
  });
});

test('review identifiers cannot escape the review route', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, authEnv)));
      for (const reviewId of ['../events', 'a/b', '..']) {
        const result = await client.callTool({ name: 'get_review_item', arguments: { reviewId } });
        assert.equal(result.isError, true, `expected ${reviewId} to be rejected`);
      }
      assert.ok(fixture.requests.every(request => !request.path.includes('/nvr/api/events')));
    } finally { await client.close(); }
  });
});

test('camera scope rejects forbidden review filters, direct identifiers, and recordings', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const forbiddenFilter = await tools.mcp__frigate__list_review_items({after: ${AFTER}, before: ${BEFORE}, cameras: ['back']});
const forbiddenItem = await tools.mcp__frigate__get_review_item({reviewId: '1700000200.300000-review'});
const forbiddenRecordings = await tools.mcp__frigate__list_recordings({camera: 'back', after: ${AFTER}, before: ${BEFORE}});
const forbiddenSummary = await tools.mcp__frigate__get_recording_summary({camera: 'back'});
text({forbiddenFilter, forbiddenItem, forbiddenRecordings, forbiddenSummary});
`, { env: { ...authEnv, FRIGATE_CAMERAS: 'front' } });
    const output = text(run.result);
    assert.match(output, /"code":"forbidden"/);
    assert.doesNotMatch(output, /1700000200\.300000|thumb_path/);
    assert.ok(fixture.requests.every(request => !request.path.includes('/back/recordings')));
  });
});

test('a missing review item is reported as not found', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_review_item({reviewId: 'missing-review'});
text(result);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"not_found"/);
  });
});

test('review timestamps with identical values keep distinct identifiers', async () => {
  const sameTime = [
    { id: 'review-a', camera: 'front', start_time: '2023-11-14T22:13:20.000000', end_time: '2023-11-14T22:13:30.000000', has_been_reviewed: false, severity: 'alert', thumb_path: '/media/a.jpg', data: { zones: [], detections: ['a'] } },
    { id: 'review-b', camera: 'front', start_time: '2023-11-14T22:13:20.000000', end_time: '2023-11-14T22:13:30.000000', has_been_reviewed: false, severity: 'alert', thumb_path: '/media/b.jpg', data: { zones: [], detections: ['b'] } },
  ];
  await withFixture({ requireAuth: true, credentials, reviews: sameTime }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_review_items({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"returned":2/);
    assert.match(output, /"id":"review-a"/);
    assert.match(output, /"id":"review-b"/);
  });
});

test('the review limit is reported as possibly incomplete without inventing paging', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_review_items({after: ${AFTER}, before: ${BEFORE}, limit: 1});
text(result);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"complete":false/);
    assert.match(output, /"truncated":true/);
    assert.match(output, /no further paging/);
    assert.doesNotMatch(output, /nextOffset|cursor/);
  });
});

test('invalid review and recording ranges are rejected before any upstream request', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const units = await tools.mcp__frigate__list_review_items({after: ${AFTER * 1000}, before: ${BEFORE * 1000}});
const reversed = await tools.mcp__frigate__list_recordings({camera: 'front', after: ${BEFORE}, before: ${AFTER}});
const window = await tools.mcp__frigate__list_recordings({camera: 'front', after: ${AFTER}, before: ${AFTER + 90000}});
text({units, reversed, window});
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"code":"invalid_request"/);
    assert.match(output, /Unix seconds/);
    assert.match(output, /maximum window/);
    assert.equal(fixture.requests.length, 0, 'invalid ranges must not reach the upstream');
  });
});

test('the recording summary rejects an unsupported window instead of ignoring it', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, authEnv)));
      const result = await client.callTool({
        name: 'get_recording_summary',
        arguments: { camera: 'front', after: AFTER, before: BEFORE },
      });
      assert.equal(result.isError, true, 'the upstream summary cannot be scoped to a window');
      assert.equal(fixture.requests.length, 0);
    } finally { await client.close(); }
  });
});

test('role denial on review and recording endpoints stays a structured error', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/review')) return false;
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Access denied. A user with the admin role is required.' }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_review_items({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"forbidden"/);
    assert.doesNotMatch(text(run.result), /admin role is required/);
  });
});

test('malformed and oversized review responses fail without echoing their body', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/review?')) return false;
      res.setHeader('content-type', 'application/json');
      res.end('{"reviews": SECRET');
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_review_items({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"malformed_response"/);
    assert.doesNotMatch(text(run.result), /SECRET/);
  });

  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.startsWith('/nvr/api/review?')) return false;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify([{ id: 'x'.repeat(4096) }]));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_review_items({after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: { ...authEnv, FRIGATE_MAX_RESPONSE_BYTES: '512' } });
    assert.match(text(run.result), /"code":"payload_too_large"/);
  });
});

test('unavailable footage is reported as gaps, not as missing evidence', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__list_recordings({camera: 'front', after: ${AFTER}, before: ${BEFORE}});
text(result);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"intervals":\[\{"startTime":1700000000,"endTime":1700000060/);
    // The gap between the two recorded segments is explicit.
    assert.match(output, /"startTime":1700000060,"endTime":1700000120/);
    assert.match(output, /"startTime":1700000180,"endTime":1700002500/);
  });
});
