/**
 * A child process that runs one deterministic code-mode investigation against
 * persistent durable storage. The parent test kills it to simulate a crash and
 * then reopens the same storage.
 *
 * Usage: tsx test/helpers/recovery-child.ts <storagePath> <apiRoot> <artifactDir>
 */
import { fileURLToPath } from 'node:url';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createRegistry, Harness } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { connectFrigateStdio, frigateNamespace } from '../../src/durable.js';
import { recoveryScript } from './recovery-script.js';

const [, , storagePath, apiRoot, artifactDir] = process.argv;
if (!storagePath || !apiRoot) throw new Error('usage: recovery-child <storage> <apiRoot> <artifactDir>');

const script = recoveryScript;

const storage = await openNodeSqliteStorage(storagePath);
const bridge = await connectFrigateStdio({
  command: process.execPath,
  args: [fileURLToPath(new URL('../../dist/cli.js', import.meta.url))],
  env: {
    FRIGATE_API_ROOT: apiRoot,
    FRIGATE_ALLOW_INSECURE_HTTP: 'true',
    FRIGATE_USERNAME: 'viewer',
    FRIGATE_PASSWORD: 'sup3r-secret-password',
    FRIGATE_ARTIFACT_DIR: artifactDir ?? '',
  },
  stderr: 'pipe',
});
const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
const models = createModels();
const faux = fauxProvider();
models.setProvider(faux.provider);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall('codemode', { code: script }), { stopReason: 'toolUse' }),
  fauxAssistantMessage('Deterministic recovery investigation finished.'),
]);
const registry = createRegistry();
registry.install(bridge.extension);
registry.install(createCodemodeExtension({ sandbox, models: false, namespaces: [frigateNamespace] }));
const context = BACKGROUND_CONTEXT;
const harness = await Harness.open(storage, { models, registry }, context);
const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
const submission = await root.submit({ type: 'input', content: 'Run the predetermined investigation.' }, context);
// The parent reads this line to know which submission to reacquire.
process.stdout.write(`${JSON.stringify({ submission: submission.id, pid: bridge.pid })}\n`);
await submission.wait(context);
await harness.close(context);
await sandbox.close();
await bridge.close();
