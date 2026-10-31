import { startFixture } from '../test/helpers/fixture.js';
import { runScript } from '../test/helpers/durable.js';

/**
 * A code-mode investigation that handles an unavailable feature and falls back
 * to ordinary filters, then delivers an evidence clip to the host.
 */
const credentials = { user: 'viewer', password: 'smoke-example-password' };
const fixture = await startFixture({
  requireAuth: true,
  credentials,
  // The modelled instance has semantic search disabled.
  semanticSearch: { enabled: false },
  clips: { bytes: Buffer.from('EXAMPLE-CLIP-BYTES') },
});
try {
  const { result } = await runScript(fixture.apiRoot, `
const search = await tools.mcp__frigate__search_events({query: 'person near the porch', after: 1699999000, before: 1700002500});
const capability = search.structuredContent.data.capability;
let fallback = null;
if (capability !== 'supported') {
  // An unknown or disabled feature falls back to ordinary filters.
  const events = await tools.mcp__frigate__list_events({after: 1699999000, before: 1700002500, labels: ['person']});
  fallback = {count: events.structuredContent.data.events.length, complete: events.structuredContent.data.completeness.complete};
}
const clip = await tools.mcp__frigate__get_event_clip({eventId: '1700000000.100000'});
text({
  capability,
  searchError: search.structuredContent.error ? search.structuredContent.error.code : null,
  fallback,
  clip: clip.structuredContent.ok ? {
    artifactId: clip.structuredContent.data.artifactId,
    uri: clip.structuredContent.data.uri,
    mimeType: clip.structuredContent.data.mimeType,
    expiresAt: clip.structuredContent.data.expiresAt,
  } : clip.structuredContent.error.code,
});
`, { env: { FRIGATE_USERNAME: credentials.user, FRIGATE_PASSWORD: credentials.password } });
  for (const item of result.content) if (item.type === 'text') console.log(item.text);
  if (result.isError) process.exitCode = 1;
  console.log(`Fixture requests: ${fixture.requests.map(request => request.path).join(', ')}`);
} finally {
  await fixture.close();
}
