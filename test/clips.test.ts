import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startFixture, type FixtureOptions } from './helpers/fixture.js';
import { runScript, serverParameters } from './helpers/durable.js';
import { connectFrigateStdio } from '../src/durable.js';

const PASSWORD = 'sup3r-secret-password';
const credentials = { user: 'viewer', password: PASSWORD };
const authEnv = { FRIGATE_USERNAME: 'viewer', FRIGATE_PASSWORD: PASSWORD };
const clipBytes = Buffer.from('FRIGATECLIPBYTES'.repeat(8));

function text(result: Awaited<ReturnType<typeof runScript>>['result']) {
  return result.content.map(block => block.type === 'text' ? block.text : '').join('\n');
}

async function withFixture(options: FixtureOptions, run: (fixture: Awaited<ReturnType<typeof startFixture>>) => Promise<void>) {
  const fixture = await startFixture(options);
  try { await run(fixture); } finally { await fixture.close(); }
}

async function artifactDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'frigate-mcp-artifacts-'));
}

test('code mode retrieves an event clip as an opaque, expiring artifact', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const run = await runScript(fixture.apiRoot, `
const clip = await tools.mcp__frigate__get_event_clip({eventId: '1700000000.100000'});
if (clip.isError || !clip.structuredContent.ok) throw new Error('Clip failed');
text(clip.structuredContent.data);
`, { env: { ...authEnv, FRIGATE_ARTIFACT_DIR: directory } });
      assert.equal(run.result.isError, false, text(run.result));
      const output = text(run.result);
      assert.match(output, /"uri":"frigate:\/\/artifact\/[a-f0-9]{32}"/);
      assert.match(output, /"mimeType":"video\/mp4"/);
      assert.match(output, new RegExp(`"byteLength":${clipBytes.length}`));
      assert.match(output, /"expiresAt":"\d{4}-\d{2}-\d{2}T/);
      assert.doesNotMatch(output, /FRIGATECLIPBYTES|\/tmp\/|frigate_token|Bearer/);
      assert.ok(fixture.requests.some(request => request.path === '/nvr/api/events/1700000000.100000/clip.mp4'));
      // The artifact is published with private permissions and no leftovers.
      const entries = await readdir(directory);
      assert.equal(entries.filter(entry => entry.endsWith('.tmp')).length, 0, 'no partial downloads may remain');
      assert.equal(entries.filter(entry => entry.endsWith('.json')).length, 1);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the durable bridge retrieves artifact bytes for the host', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const bridge = await connectFrigateStdio(serverParameters(fixture.apiRoot, { ...authEnv, FRIGATE_ARTIFACT_DIR: directory }));
      try {
        const clip = await (bridge.extension.tools ?? [])
          .find(tool => tool.name === 'mcp__frigate__get_event_clip');
        assert.ok(clip);
        const result = await clip.execute({ eventId: '1700000000.100000' }, {} as never, {} as never);
        const structured = result.structuredOutput as { structuredContent: { data: { uri: string } } };
        const artifact = await bridge.readArtifact(structured.structuredContent.data.uri);
        assert.equal(artifact.mimeType, 'video/mp4');
        assert.equal(artifact.byteLength, clipBytes.length);
        assert.equal(Buffer.from(artifact.blob, 'base64').toString('utf8'), clipBytes.toString('utf8'));
        await assert.rejects(bridge.readArtifact('frigate://artifact/not-an-id'), /Unknown Frigate artifact URI/);
      } finally { await bridge.close(); }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a conventional MCP resource client reads the artifact bytes', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const client = new Client({ name: 'test', version: '1' });
      try {
        await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, { ...authEnv, FRIGATE_ARTIFACT_DIR: directory })));
        const clip = await client.callTool({ name: 'get_event_clip', arguments: { eventId: '1700000000.100000' } });
        assert.equal(clip.isError, false);
        const structured = clip.structuredContent as { data: { uri: string; byteLength: number } };
        assert.equal(structured.data.byteLength, clipBytes.length);
        const resource = await client.readResource({ uri: structured.data.uri });
        assert.equal(resource.contents.length, 1);
        const content = resource.contents[0]!;
        assert.equal(content.mimeType, 'video/mp4');
        assert.ok('blob' in content);
        assert.equal(Buffer.from(content.blob, 'base64').toString('utf8'), clipBytes.toString('utf8'));
      } finally { await client.close(); }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('guessed and forbidden artifact identifiers are refused', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const client = new Client({ name: 'test', version: '1' });
      try {
        await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, { ...authEnv, FRIGATE_ARTIFACT_DIR: directory })));
        for (const uri of ['frigate://artifact/00000000000000000000000000000000', 'frigate://artifact/../secrets', 'file:///etc/passwd']) {
          await assert.rejects(client.readResource({ uri }), /not found|Unknown artifact|expired|outside/);
        }
      } finally { await client.close(); }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an event clip whose duration cannot be bounded is refused before any download', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_event_clip({eventId: '1700000300.400000'});
text(result.structuredContent);
`, { env: { ...authEnv, FRIGATE_ARTIFACT_DIR: directory } });
      const output = text(run.result);
      assert.match(output, /"code":"invalid_request"/);
      assert.match(output, /duration/);
      assert.equal(fixture.requests.filter(request => request.path.includes('clip.mp4')).length, 0);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('recording clips require a bounded interval and a permitted camera', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const run = await runScript(fixture.apiRoot, `
const tooLong = await tools.mcp__frigate__get_recording_clip({camera: 'front', start: 1700000000, end: 1700009999});
const reversed = await tools.mcp__frigate__get_recording_clip({camera: 'front', start: 1700000100, end: 1700000000});
const forbidden = await tools.mcp__frigate__get_recording_clip({camera: 'back', start: 1700000000, end: 1700000060});
text({tooLong, reversed, forbidden});
`, { env: { ...authEnv, FRIGATE_ARTIFACT_DIR: directory, FRIGATE_CAMERAS: 'front' } });
      const output = text(run.result);
      assert.match(output, /"code":"invalid_request"/);
      assert.match(output, /"code":"forbidden"/);
      assert.equal(fixture.requests.filter(request => request.path.includes('clip.mp4')).length, 0);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a recording clip is published with its evidence reference', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_recording_clip({camera: 'front', start: 1700000000, end: 1700000060});
text(result.structuredContent.data);
`, { env: { ...authEnv, FRIGATE_ARTIFACT_DIR: directory } });
      const output = text(run.result);
      assert.match(output, /"kind":"recording_clip"/);
      assert.match(output, /"camera":"front"/);
      assert.match(output, /"start":1700000000/);
      assert.match(output, /"end":1700000060/);
      assert.ok(fixture.requests.some(request => request.path === '/nvr/api/front/start/1700000000/end/1700000060/clip.mp4'));
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a missing recording and a wrong clip MIME type fail without publishing an artifact', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { missing: true } }, async fixture => {
      const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_event_clip({eventId: '1700000000.100000'});
text(result.structuredContent);
`, { env: { ...authEnv, FRIGATE_ARTIFACT_DIR: directory } });
      assert.match(text(run.result), /"code":"not_found"/);
      assert.deepEqual(await readdir(directory), []);
    });

    await withFixture({ requireAuth: true, credentials, clips: { wrongMime: true } }, async fixture => {
      const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_event_clip({eventId: '1700000000.100000'});
text(result.structuredContent);
`, { env: { ...authEnv, FRIGATE_ARTIFACT_DIR: directory } });
      assert.match(text(run.result), /"code":"malformed_response"/);
      assert.deepEqual(await readdir(directory), [], 'an invalid clip is never published');
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an oversized clip is rejected while streaming and leaves no partial file', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: Buffer.alloc(4096, 7) } }, async fixture => {
      const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_event_clip({eventId: '1700000000.100000'});
text(result.structuredContent);
`, { env: { ...authEnv, FRIGATE_ARTIFACT_DIR: directory, FRIGATE_CLIP_MAX_BYTES: '512' } });
      assert.match(text(run.result), /"code":"payload_too_large"/);
      assert.deepEqual(await readdir(directory), [], 'a partial download is never published');
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('the artifact quota is enforced', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const run = await runScript(fixture.apiRoot, `
const result = await tools.mcp__frigate__get_event_clip({eventId: '1700000000.100000'});
text(result.structuredContent);
`, { env: { ...authEnv, FRIGATE_ARTIFACT_DIR: directory, FRIGATE_ARTIFACT_QUOTA_BYTES: '64' } });
      assert.match(text(run.result), /"code":"quota_exceeded"/);
      assert.deepEqual(await readdir(directory), []);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an expired artifact fails explicitly even when its metadata is retained', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { bytes: clipBytes } }, async fixture => {
      const client = new Client({ name: 'test', version: '1' });
      try {
        await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, { ...authEnv, FRIGATE_ARTIFACT_DIR: directory, FRIGATE_ARTIFACT_TTL_SECONDS: '1' })));
        const clip = await client.callTool({ name: 'get_event_clip', arguments: { eventId: '1700000000.100000' } });
        const structured = clip.structuredContent as { data: { uri: string } };
        // Wait past the TTL, then read the artifact again.
        await new Promise(resolve => setTimeout(resolve, 1100));
        await assert.rejects(client.readResource({ uri: structured.data.uri }), /expired/i);
      } finally { await client.close(); }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a cancelled clip download leaves no artifact behind', async () => {
  const directory = await artifactDirectory();
  try {
    await withFixture({ requireAuth: true, credentials, clips: { stall: true } }, async fixture => {
      const client = new Client({ name: 'test', version: '1' });
      try {
        await client.connect(new StdioClientTransport(serverParameters(fixture.apiRoot, { ...authEnv, FRIGATE_ARTIFACT_DIR: directory })));
        const controller = new AbortController();
        const request = client.callTool({ name: 'get_event_clip', arguments: { eventId: '1700000000.100000' } }, undefined, { signal: controller.signal });
        const rejected = assert.rejects(request);
        await new Promise(resolve => setTimeout(resolve, 300));
        controller.abort();
        await rejected;
        // The server cleans the partial download up as the call unwinds.
        await new Promise(resolve => setTimeout(resolve, 300));
        assert.deepEqual(await readdir(directory), [], 'an abandoned download is cleaned up');
      } finally { await client.close(); }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
