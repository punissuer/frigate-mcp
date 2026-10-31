import { startFixture } from '../test/helpers/fixture.js';
import { runScript } from '../test/helpers/durable.js';

/**
 * A code-mode investigation over a local fixture: discovery, bounded
 * cross-camera reads, an image forwarded with `image()`, and a compact evidence
 * summary with explicit completeness metadata.
 */
const credentials = { user: 'viewer', password: 'smoke-example-password' };
const fixture = await startFixture({ requireAuth: true, credentials });
try {
  const { result } = await runScript(fixture.apiRoot, `
const cameras = await tools.mcp__frigate__list_cameras({});
if (cameras.isError || !cameras.structuredContent.ok) throw new Error('Discovery failed');
const ids = cameras.structuredContent.data.cameras.map(camera => camera.id);

// Bounded cross-camera reads: two independent reads in parallel, never a fan-out
// beyond the configured upstream concurrency.
const events = await Promise.all(ids.map(camera =>
  tools.mcp__frigate__list_events({after: 1699999000, before: 1700002500, cameras: [camera]})));
const status = await tools.mcp__frigate__get_system_status({});

// Forward one image instead of printing its base64.
const frame = await tools.mcp__frigate__get_latest_frame({camera: ids[0]});
if (frame.isError || !frame.structuredContent.ok) throw new Error('Frame failed');
const picture = frame.content.find(block => block.type === 'image');
if (picture) image(picture);

text({
  cameras: ids,
  perCameraEvents: events.map(result => ({
    camera: result.structuredContent.data.events.length,
    complete: result.structuredContent.data.completeness.complete,
  })),
  authorizedApiAccess: status.structuredContent.data.authorizedApiAccess,
  imageForwarded: Boolean(picture),
  captureTime: frame.structuredContent.data.captureTime,
});
`, { env: { FRIGATE_USERNAME: credentials.user, FRIGATE_PASSWORD: credentials.password } });
  for (const item of result.content) if (item.type === 'text') console.log(item.text);
  if (result.isError) process.exitCode = 1;
  console.log(`Fixture requests: ${fixture.requests.map(request => request.path).join(', ')}`);
} finally {
  await fixture.close();
}
