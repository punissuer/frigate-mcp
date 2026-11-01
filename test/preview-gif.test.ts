import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { gifBytes, startFixture, type FixtureOptions } from './helpers/fixture.js';
import { runScript, serverParameters } from './helpers/durable.js';

const PASSWORD = 'sup3r-secret-password';
const credentials = { user: 'viewer', password: PASSWORD };
const authEnv = { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD };

function text(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

/** The first line of the output that starts a JSON object, parsed. */
function jsonLine<T>(output: string): T {
  const line = output.split('\n').find(candidate => candidate.startsWith('{'));
  assert.ok(line, `no JSON line in output: ${output}`);
  return JSON.parse(line) as T;
}

interface PreviewOutcome {
  ok: boolean;
  error?: { code: string; message: string };
}

function imageItems(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return (result as unknown as { content: { type: string; mimeType?: string; data?: string }[] }).content.filter(item => item.type === 'image');
}

async function withFixture(options: FixtureOptions, run: (fixture: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const fixture = await startFixture(options);
  try { await run(fixture); } finally { await fixture.close(); }
}

const PREVIEW_SCRIPT = `
const gif = await tools.mcp__frigate__get_event_preview_gif({eventId: '1700000000.100000'});
if (gif.isError || !gif.structuredContent.ok) throw new Error('Preview failed');
const picture = gif.content.find(block => block.type === 'image');
if (!picture) throw new Error('No image block');
image(picture);
text({ metadata: gif.structuredContent, mimeType: picture.mimeType, dataLength: picture.data.length });
`;

test('code mode forwards an event preview GIF as an image block without printing base64', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, PREVIEW_SCRIPT, { env: authEnv });
    assert.equal(run.result.isError, false, text(run.result));
    const output = text(run.result);
    assert.match(output, /"kind":"event_preview_gif"/);
    assert.match(output, /"mimeType":"image\/gif"/);
    assert.match(output, /"camera":"front"/);
    assert.match(output, new RegExp(`"byteLength":${gifBytes.length}`));
    const items = (run.result as unknown as { content: { type: string; mimeType?: string }[] }).content;
    const forwarded = items.find(item => item.type === 'image');
    assert.ok(forwarded, 'the GIF must be forwarded as an image item');
    assert.equal(forwarded.mimeType, 'image/gif');
    // The event is resolved before its preview is requested.
    const paths = fixture.requests.map(request => request.path);
    assert.ok(paths.includes('/nvr/api/events/1700000000.100000'));
    assert.ok(paths.includes('/nvr/api/events/1700000000.100000/preview.gif'));
    assert.ok(paths.indexOf('/nvr/api/events/1700000000.100000') < paths.indexOf('/nvr/api/events/1700000000.100000/preview.gif'));
  });
});

test('a missing preview and a missing event are distinct outcomes', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.endsWith('/1700000100.200000/preview.gif')) return false;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'No preview' }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const none = await tools.mcp__frigate__get_event_preview_gif({eventId: '1700000100.200000'});
const gone = await tools.mcp__frigate__get_event_preview_gif({eventId: '1699999999.999999'});
text(JSON.stringify({none: none.structuredContent, gone: gone.structuredContent}));
`, { env: authEnv });
    const parsed = jsonLine<{ none: PreviewOutcome; gone: PreviewOutcome }>(text(run.result));
    assert.equal(parsed.none.error?.code, 'media_unavailable');
    assert.match(parsed.none.error?.message ?? '', /No preview GIF is available for this event/);
    assert.equal(parsed.gone.error?.code, 'not_found');
    assert.match(parsed.gone.error?.message ?? '', /may have expired/);
  });
});

test('a response that is not a GIF is rejected, whether the type or the bytes are wrong', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (req.url?.endsWith('/1700000000.100000/preview.gif')) {
        res.setHeader('content-type', 'text/html');
        res.end('<html>SECRET</html>');
        return true;
      }
      if (req.url?.endsWith('/1700000100.200000/preview.gif')) {
        res.setHeader('content-type', 'image/gif');
        res.end(Buffer.from('not really a gif'));
        return true;
      }
      return false;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const wrongType = await tools.mcp__frigate__get_event_preview_gif({eventId: '1700000000.100000'});
const wrongBytes = await tools.mcp__frigate__get_event_preview_gif({eventId: '1700000100.200000'});
text({wrongType: wrongType.structuredContent, wrongBytes: wrongBytes.structuredContent});
`, { env: authEnv });
    const output = text(run.result);
    assert.equal((output.match(/"code":"malformed_response"/g) ?? []).length, 2);
    assert.doesNotMatch(output, /SECRET|<html>/);
  });
});

test('an oversized preview is rejected while streaming', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.endsWith('/preview.gif')) return false;
      res.setHeader('content-type', 'image/gif');
      res.write(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(1024, 1)]));
      res.end(Buffer.alloc(1024, 1));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const gif = await tools.mcp__frigate__get_event_preview_gif({eventId: '1700000000.100000'});
text(gif.structuredContent);
`, { env: { ...authEnv, FRIGATE_MEDIA_MAX_BYTES: '256' } });
    assert.match(text(run.result), /"code":"payload_too_large"/);
  });
});

test('camera scope is enforced before any preview is fetched', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const gif = await tools.mcp__frigate__get_event_preview_gif({eventId: '1700000200.300000'});
text(gif.structuredContent);
`, { env: { ...authEnv, FRIGATE_CAMERAS: 'front' } });
    assert.match(text(run.result), /"code":"forbidden"/);
    assert.ok(fixture.requests.every(request => !request.path.includes('/1700000200.300000/preview.gif')));
  });
});

test('an invalid event identifier is rejected before any request is made', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const gif = await tools.mcp__frigate__get_event_preview_gif({eventId: 'a..b'});
text(gif.structuredContent);
`, { env: authEnv });
    assert.match(text(run.result), /"code":"invalid_request"/);
    assert.ok(fixture.requests.every(request => !request.path.includes('preview.gif')));
    assert.ok(fixture.requests.every(request => !request.path.includes('a..b')));
  });
});

test('a GIF87a preview is accepted', async () => {
  const gif87a = Buffer.from('GIF87a\x01\x00\x01\x00\x00\x00\x00;', 'binary');
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.endsWith('/1700000000.100000/preview.gif')) return false;
      res.setHeader('content-type', 'image/gif');
      res.end(gif87a);
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, PREVIEW_SCRIPT, { env: authEnv });
    assert.equal(run.result.isError, false, text(run.result));
    assert.match(text(run.result), /"ok":true/);
    const forwarded = imageItems(run.result)[0];
    assert.ok(forwarded?.data, 'the GIF87a must be forwarded as an image item');
    assert.equal(forwarded.mimeType, 'image/gif');
    assert.equal(Buffer.from(forwarded.data, 'base64').subarray(0, 6).toString('latin1'), 'GIF87a');
  });
});

test('GIF bytes served with a JPEG content type are rejected', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.endsWith('/1700000000.100000/preview.gif')) return false;
      res.setHeader('content-type', 'image/jpeg');
      res.end(gifBytes);
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const gif = await tools.mcp__frigate__get_event_preview_gif({eventId: '1700000000.100000'});
const picture = gif.content.find(block => block.type === 'image');
if (picture) image(picture);
text(JSON.stringify(gif.structuredContent));
`, { env: authEnv });
    const outcome = jsonLine<PreviewOutcome>(text(run.result));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error?.code, 'malformed_response');
    assert.equal(imageItems(run.result).length, 0, 'no image may be forwarded for a mistyped response');
  });
});

test('an upstream error on the preview is a distinct read error, never an image', async () => {
  await withFixture({
    requireAuth: true,
    credentials,
    override: (req, res) => {
      if (!req.url?.endsWith('/1700000000.100000/preview.gif')) return false;
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: 'Internal server error' }));
      return true;
    },
  }, async fixture => {
    const run = await runScript(fixture.apiRoot, `
const gif = await tools.mcp__frigate__get_event_preview_gif({eventId: '1700000000.100000'});
const picture = gif.content.find(block => block.type === 'image');
if (picture) image(picture);
text(JSON.stringify({isError: gif.isError === true, ok: gif.structuredContent.ok}));
`, { env: authEnv });
    const outcome = jsonLine<{ isError: boolean; ok: boolean }>(text(run.result));
    assert.equal(outcome.isError, true);
    assert.equal(outcome.ok, false);
    assert.equal(imageItems(run.result).length, 0, 'an upstream error must never be forwarded as an image');
  });
});

test('an event inside the configured camera scope still yields its preview', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const run = await runScript(fixture.apiRoot, PREVIEW_SCRIPT, { env: { ...authEnv, FRIGATE_CAMERAS: 'front' } });
    assert.equal(run.result.isError, false, text(run.result));
    assert.match(text(run.result), /"camera":"front"/);
    assert.ok(fixture.requests.some(request => request.path === '/nvr/api/events/1700000000.100000/preview.gif'));
  });
});

test('a conventional MCP client receives a GIF image block with structured metadata', async () => {
  await withFixture({ requireAuth: true, credentials }, async fixture => {
    const client = new Client({ name: 'test', version: '1' });
    try {
      await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, authEnv)));
      const result = await client.callTool({ name: 'get_event_preview_gif', arguments: { eventId: '1700000000.100000' } });
      const content = result.content as { type: string; mimeType?: string; data?: string; text?: string }[];
      const image = content.find(block => block.type === 'image');
      assert.equal(image?.mimeType, 'image/gif');
      assert.equal(Buffer.from(image?.data ?? '', 'base64').subarray(0, 6).toString('latin1'), 'GIF89a');
      const structured = result.structuredContent as { ok: boolean; data: { kind: string; byteLength: number } };
      assert.equal(structured.ok, true);
      assert.equal(structured.data.kind, 'event_preview_gif');
      assert.equal(JSON.stringify(structured).includes(image?.data ?? 'x'), false, 'the structured result never carries the bytes');
    } finally {
      await client.close();
    }
  });
});
