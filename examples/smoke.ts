import { startFixture } from '../test/helpers/fixture.js';
import { runScript } from '../test/helpers/durable.js';

const fixture = await startFixture();
try {
  const { result } = await runScript(fixture.apiRoot, `
const namespace = await describeNamespace('frigate');
if (!namespace) throw new Error('Frigate namespace not found');
const result = await tools.mcp__frigate__get_system_status({});
if (result.isError || !result.structuredContent.ok) throw new Error('Status failed');
text(result.structuredContent);
`);
  for (const item of result.content) if (item.type === 'text') console.log(item.text);
  if (result.isError) process.exitCode = 1;
  console.log(`Fixture requests: ${fixture.requests.map(request => request.path).join(', ')}`);
} finally {
  await fixture.close();
}
