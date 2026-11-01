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
    assert.ok(paths.indexOf('/nvr/api/events/1700000000.100000') < paths.indexOf('/nvr/api/events/1700000000.100000/preview.gif'));
  });
});

test('a missing preview, a missing event and a bad event id are distinct outcomes', async () => {
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
text({none: none.structuredContent, gone: gone.structuredContent});
`, { env: authEnv });
    const output = text(run.result);
    assert.match(output, /"code":"media_unavailable"/);
    assert.match(output, /No preview GIF is available for this event/);
    assert.match(output, /"code":"not_found"/);
    assert.match(output, /may have expired/);
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
