import { fileURLToPath } from 'node:url';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { connectFrigateStdio, frigateNamespace } from '../../src/durable.js';

export function serverParameters(apiRoot: string, env: Record<string, string> = {}) {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('../../dist/cli.js', import.meta.url))],
    env: { FRIGATE_API_ROOT: apiRoot, FRIGATE_ALLOW_INSECURE_HTTP: 'true', ...env },
    stderr: 'pipe' as const,
  };
}

export async function runScript(apiRoot: string, code: string, options: {
  beforeSubmit?: (pid: number | null) => Promise<void>;
  env?: Record<string, string>;
} = {}) {
  const bridge = await connectFrigateStdio(serverParameters(apiRoot, options.env));
  const sandbox = new CodemodeSandbox({ memoryLimitBytes: 64 * 1024 * 1024 });
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall('codemode', { code }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Deterministic fixture investigation finished.'),
  ]);
  const registry = createRegistry();
  registry.install(bridge.extension);
  registry.install(createCodemodeExtension({ sandbox, models: false, namespaces: [frigateNamespace] }));
  const context = BACKGROUND_CONTEXT;
  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const root = await harness.root(context, { agent: { model: { provider: 'faux', modelId: 'faux-1' } } });
    const agent = await root.agent(context);
    await options.beforeSubmit?.(bridge.pid);
    const submission = await root.submit({ type: 'input', content: 'Run the predetermined investigation.' }, context);
    const settled = await submission.wait(context);
    if (settled.status !== 'done') throw new Error(`Fixture run did not settle: ${settled.status}`);
    const messages = (await root.context(context)).messages;
    const result = messages.find(message => message.role === 'toolResult' && message.toolName === 'codemode');
    if (!result || result.role !== 'toolResult') throw new Error('Missing code-mode result');
    return { result, offered: agent.tools.map(tool => tool.name), callable: agent.callable.map(tool => tool.name), pid: bridge.pid };
  } finally {
    await harness.close(context);
    await sandbox.close();
    await bridge.close();
  }
}
