/**
 * A pi-durable host with code mode and the Frigate MCP bridge.
 *
 * This is the smallest complete wiring: a durable harness, the code-mode
 * extension, and the Frigate bridge registered as a `frigate` namespace. The
 * model writes JavaScript that calls the Frigate tools inside the sandbox;
 * credentials never enter it.
 *
 * Run it offline against the built-in fixture:
 *
 *   npm run example:pi-durable
 */
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { connectFrigateStdio, frigateNamespace } from '../src/durable.js';
import { startFixture } from '../test/helpers/fixture.js';

export interface HostOptions {
  /** The API root of the Frigate instance, without credentials. */
  apiRoot: string;
  /** Environment for the MCP server subprocess. Keep the secrets here. */
  env?: Record<string, string>;
  /** Where the durable harness keeps its state. Reuse it across restarts. */
  storagePath?: string;
  /** The model catalog for the harness. */
  models?: ReturnType<typeof createModels>;
  /** The code the model writes. */
  script?: string;
}

const investigation = `
const namespace = await describeNamespace('frigate');
const cameras = await tools.mcp__frigate__list_cameras({});
if (cameras.isError || !cameras.structuredContent.ok) throw new Error('Discovery failed');
const status = await tools.mcp__frigate__get_system_status({});
if (status.isError || !status.structuredContent.ok) throw new Error('Status failed');

// Forward one image to the model instead of printing its base64.
const frame = await tools.mcp__frigate__get_latest_frame({camera: cameras.structuredContent.data.cameras[0].id});
if (!frame.isError && frame.structuredContent.ok) {
  const picture = frame.content.find(block => block.type === 'image');
  if (picture) image(picture);
}

text({
  authorizedApiAccess: status.structuredContent.data.authorizedApiAccess,
  compatibility: status.structuredContent.data.version?.compatibility,
  cameras: cameras.structuredContent.data.cameras.map(camera => camera.id),
});
`;

/**
 * Run one investigation on a durable harness.
 *
 * The bridge, the sandbox and the harness are all created here and must be
 * created again after a restart; only the storage is persisted.
 */
export async function runInvestigation(options: HostOptions) {
  const context = BACKGROUND_CONTEXT;
  const storagePath = options.storagePath ?? join(await mkdtemp(join(tmpdir(), 'frigate-mcp-host-')), 'session.sqlite');
  const storage = await openNodeSqliteStorage(storagePath);
  const bridge = await connectFrigateStdio({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/cli.js', import.meta.url))],
    env: { FRIGATE_API_ROOT: options.apiRoot, ...(options.env ?? {}) },
    stderr: 'pipe',
  });
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 });
  const registry = createRegistry();
  registry.install(bridge.extension);
  registry.install(createCodemodeExtension({
    sandbox,
    namespaces: [frigateNamespace],
    // `models: false` keeps the model catalog out of the sandbox; drop it if
    // the script should also classify or generate images.
    models: false,
  }));
  const models = options.models ?? createModels();
  const harness = await Harness.open(storage, { models, registry }, context);
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
    const submission = await root.submit({ type: 'input', content: 'Run the Frigate investigation.' }, context);
    const settled = await submission.wait(context);
    const messages = await root.context(context).then(value => value.messages);
    const result = messages.find(message => message.role === 'toolResult' && message.toolName === 'codemode');
    return { settled, result, storagePath };
  } finally {
    await harness.close(context);
    await sandbox.close();
    await bridge.close();
  }
}

// When run directly: a deterministic, offline demonstration.
if (import.meta.url === `file://${process.argv[1]}`) {
  const credentials = { user: 'viewer', password: 'offline-example-password' };
  const fixture = await startFixture({ requireAuth: true, credentials });
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code: investigation }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Investigation finished.'),
  ]);
  try {
    const { result } = await runInvestigation({
      apiRoot: fixture.apiRoot,
      env: { FRIGATE_ALLOW_INSECURE_HTTP: 'true', FRIGATE_USERNAME: credentials.user, FRIGATE_PASSWORD: credentials.password },
      models,
    });
    for (const item of result?.content ?? []) {
      if (typeof item === 'string') console.log(item);
      else if (item.type === 'text') console.log(item.text);
      else console.log(`[${item.type}]`);
    }
    console.log(`Fixture requests: ${fixture.requests.map(request => request.path).join(', ')}`);
  } finally {
    await fixture.close();
  }
}
