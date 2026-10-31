import { startFixture } from '../test/helpers/fixture.js';
import { runScript } from '../test/helpers/durable.js';

const credentials = { user: 'viewer', password: 'smoke-example-password' };
const fixture = await startFixture({ requireAuth: true, credentials });
try {
  const { result } = await runScript(fixture.apiRoot, `
const namespace = await describeNamespace('frigate');
if (!namespace) throw new Error('Frigate namespace not found');
const status = await tools.mcp__frigate__get_system_status({});
if (status.isError || !status.structuredContent.ok) throw new Error('Status failed');
const cameras = await tools.mcp__frigate__list_cameras({});
if (cameras.isError || !cameras.structuredContent.ok) throw new Error('Camera discovery failed');
const capabilities = await tools.mcp__frigate__get_capabilities({});
if (capabilities.isError || !capabilities.structuredContent.ok) throw new Error('Capability detection failed');
const events = await tools.mcp__frigate__list_events({after: 1699999000, before: 1700001000});
if (events.isError || !events.structuredContent.ok) throw new Error('Event listing failed');
text({
  status: status.structuredContent,
  cameras: cameras.structuredContent,
  capabilities: capabilities.structuredContent,
  events: events.structuredContent.data,
});
`, { env: { FRIGATE_USERNAME: credentials.user, FRIGATE_PASSWORD: credentials.password } });
  for (const item of result.content) if (item.type === 'text') console.log(item.text);
  if (result.isError) process.exitCode = 1;
  console.log(`Fixture requests: ${fixture.requests.map(request => request.path).join(', ')}`);
} finally {
  await fixture.close();
}
