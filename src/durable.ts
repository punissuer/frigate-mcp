import { isDeepStrictEqual } from 'node:util';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type JsonObject } from '@earendil-works/pi-durable';
import { outputSchema, statusManifest, STATUS_DESCRIPTION, STATUS_TOOL } from './contract.js';

export const frigateNamespace = {
  name: 'frigate', prefix: 'mcp__frigate__',
  description: 'Read-only Frigate investigation tools. Inspect structuredContent.ok before reporting observations.',
  instructions: 'Tool results preserve MCP content, structuredContent, and isError. Transport/harness failures may reject; handle both. No credentials are available in the sandbox.',
};
const envelopeSchema = Type.Object({
  content: Type.Array(Type.Unknown(), { maxItems: 8 }),
  structuredContent: Type.Optional(Type.Unsafe(statusManifest.outputSchema)),
  isError: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

/**
 * A host-owned, optional bridge. Create again on host restart; persist only the
 * durable harness's state, never this client or its deployment environment.
 */
export async function connectFrigateStdio(parameters: StdioServerParameters) {
  const transport = new StdioClientTransport(parameters);
  const client = new Client({ name: 'frigate-durable-bridge', version: '0.1.0' });
  try {
    await client.connect(transport);
    const manifest = await client.listTools();
    const tool = manifest.tools[0];
    if (manifest.nextCursor || manifest.tools.length !== 1 || !tool || tool.name !== STATUS_TOOL
      || !isDeepStrictEqual(tool.inputSchema, statusManifest.inputSchema)
      || !isDeepStrictEqual(tool.outputSchema, statusManifest.outputSchema)
      || tool.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint !== false) {
      throw new Error('Incompatible Frigate read-only manifest');
    }
    const status = defineTool({
      name: `mcp__frigate__${STATUS_TOOL}`,
      description: STATUS_DESCRIPTION,
      parameters: Type.Object({}, { additionalProperties: false }),
      structuredOutputSchema: envelopeSchema,
      callers: ['tools'],
      replay: 'safe',
      execute: async (_args, _api, context) => {
        try {
          const result = CallToolResultSchema.parse(await client.callTool({ name: STATUS_TOOL, arguments: {} }, undefined, {
            ...(context.abortSignal ? { signal: context.abortSignal } : {}),
            timeout: 65_000,
          }));
          const parsed = outputSchema.safeParse(result.structuredContent);
          if (!parsed.success || result.isError !== !parsed.data.ok || result.content.length !== 1
            || result.content[0]?.type !== 'text' || result.content[0].text !== JSON.stringify(result.structuredContent)) {
            throw new Error('Invalid MCP response');
          }
          return {
            output: [{ type: 'text', text: result.content[0].text }],
            structuredOutput: JSON.parse(JSON.stringify(result)) as JsonObject,
            isError: result.isError === true,
          };
        } catch {
          // SDK/transport errors can contain remote responses or deployment details.
          throw new Error('Frigate MCP call failed, was cancelled, or returned an incompatible result');
        }
      },
    });
    return {
      extension: defineExtension({ name: 'frigate-mcp', tools: [status] }),
      close: () => client.close(),
      /** Useful for lifecycle supervision; never persisted or sent to the model. */
      get pid() { return transport.pid; },
    };
  } catch {
    await client.close().catch(() => undefined);
    throw new Error('Unable to connect to a compatible Frigate MCP server');
  }
}
