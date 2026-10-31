import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture, type FixtureOptions } from './helpers/fixture.js';
import { runScript, serverParameters } from './helpers/durable.js';

const PASSWORD = 'sup3r-secret-password';
const credentials = { user: 'viewer', password: PASSWORD };
const authEnv = { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD };

function text(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

async function withFixture(options: FixtureOptions, run: (fixture: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const fixture = await startFixture(options);
  try { await run(fixture); } finally { await fixture.close(); }
}

test('code mode forwards a latest frame as an image block without printing base64', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const frame = await tools.mcp__frigate__get_latest_frame({camera: 'front'});
if (frame.isError || !frame.structuredContent.ok) throw new Error('Frame failed');
const picture = frame.content.find(block => block.type === 'image');
if (!picture) throw new Error('No image block');
image(picture);
text({
  metadata: frame.structuredContent,
  imageType: picture.type,
  mimeType: picture.mimeType,
  dataLength: picture.data.length,
});
`, { env: authEnv });
    assert.equal(run.result.isError, false, text(run.result));
    const output = text(run.result);
    assert.match(output, /"kind":"latest_frame"/);
    assert.match(output, /"captureTime":"unknown"/);
    assert.match(output, /"source":"live"/);
    assert.match(output, /"mimeType":"image\/jpeg"/);
    assert.doesNotMatch(output, /"data":"\//);
    // The code-mode result carries the image item, not base64 text.
    const items = (run.result as unknown as { content: { type: string }[] }).content;
    assert.ok(items.some(item => item.type === 'image'), 'the image must be forwarded as an image item');
  });
});

test('an offline camera is reported as a preview fallback, not a live frame', async () => {
  await withFixture({ requireAuth: true, credentials, cameras: { offline: ['front'] } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const frame = await tools.mcp__frigate__get_latest_frame({camera: 'front'});
text(frame.structuredContent);
text(frame.structuredContent.meta.warnings);
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"source":"preview_fallback"/);
    assert.match(output, /preview frame, not a live view/);
    assert.match(output, /capture time/);
  });
});

test('a missing camera and a wrong media type fail with distinct errors', async () => {
  await withFixture({ requireAuth: true, credentials, cameras: { missing: ['front'], wrongMime: ['back'] } }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const missing = await tools.mcp__frigate__get_latest_frame({camera: 'front'});
const wrongMime = await tools.mcp__frigate__get_latest_frame({camera: 'back'});
text({missing, wrongMime});
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"code":"not_found"/);
    assert.match(output, /"code":"malformed_response"/);
    assert.doesNotMatch(output, /SECRET|<html>/);
  });
});

test('an oversized image is rejected while streaming', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.endsWith('/latest.jpg')) return false;
      res.setHeader('content-type', 'image/jpeg');
      res.write(Buffer.alloc(1024, 1));
      res.end(Buffer.alloc(1024, 1));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const frame = await tools.mcp__frigate__get_latest_frame({camera: 'front'});
text(frame.structuredContent);
`, { env: { ...authEnv, FRIGATE_MEDIA_MAX_BYTES: '256' } });
    assert.match(text(run.result), /"code":"payload_too_large"/);
  });
});

test('event images resolve the camera before fetching media and report missing snapshots', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const snapshot = await tools.mcp__frigate__get_event_image({eventId: '1700000000.100000', kind: 'snapshot'});
const missing = await tools.mcp__frigate__get_event_image({eventId: '1700000200.300000', kind: 'snapshot'});
const thumbnail = await tools.mcp__frigate__get_event_image({eventId: '1700000000.100000', kind: 'thumbnail'});
const expired = await tools.mcp__frigate__get_event_image({eventId: '1699999999.999999', kind: 'snapshot'});
text({snapshot, missing, thumbnail, expired});
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"kind":"event_snapshot"/);
    assert.match(output, /"kind":"event_thumbnail"/);
    assert.match(output, /"code":"media_unavailable"/);
    assert.match(output, /"code":"not_found"/);
    assert.match(output, /may have expired/);
    // The event is resolved before its media is requested.
    const paths = fixture.requests.map(request => request.path);
    assert.ok(paths.indexOf('/nvr/api/events/1700000000.100000') < paths.indexOf('/nvr/api/events/1700000000.100000/snapshot.jpg'));
  });
});

test('camera scope is enforced before any media is fetched', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const frame = await tools.mcp__frigate__get_latest_frame({camera: 'back'});
const image = await tools.mcp__frigate__get_event_image({eventId: '1700000200.300000', kind: 'snapshot'});
text({frame, image});
`, { env: { ...authEnv, FRIGATE_CAMERAS: 'front' } });
    const output = text(run.result);
    assert.match(output, /"code":"forbidden"/);
    assert.ok(fixture.requests.every(request => !request.path.includes('/back/latest.jpg')));
    assert.ok(fixture.requests.every(request => !request.path.includes('/1700000200.300000/snapshot.jpg')));
  });
});

test('a conventional MCP client receives an image block with structured metadata', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, authEnv)));
      const result = await client.callTool({ name: 'get_latest_frame', arguments: { camera: 'front' } });
      assert.equal(result.isError, false);
      const blocks = result.content as { type: string; mimeType?: string; text?: string }[];
      const image = blocks.find(block => block.type === 'image');
      assert.ok(image);
      assert.equal(image.mimeType, 'image/jpeg');
      const textBlock = blocks.find(block => block.type === 'text');
      assert.ok(textBlock && textBlock.text);
      const structured = JSON.parse(textBlock.text);
      assert.equal(structured.data.kind, 'latest_frame');
      // The structured result never carries the image bytes.
      assert.doesNotMatch(textBlock.text, /"data":"/);
    } finally { await client.close(); }
  });
});

test('cancelling an image request aborts the upstream read', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.endsWith('/latest.jpg')) return false;
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      res.write(Buffer.alloc(16, 1));
      return true;
    },
  }, async fixture => {
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, authEnv)));
      const controller = new AbortController();
      const request = client.callTool({ name: 'get_latest_frame', arguments: { camera: 'front' } }, undefined, { signal: controller.signal });
      const rejected = assert.rejects(request);
      await new Promise(resolve => setTimeout(resolve, 200));
      controller.abort();
      await rejected;
    } finally { await client.close(); }
  });
});
