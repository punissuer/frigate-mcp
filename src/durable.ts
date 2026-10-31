import { isDeepStrictEqual } from 'node:util';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, type JsonObject } from '@earendil-works/pi-durable';
import { toolManifests, toolOutputSchemas, type ToolName } from './contract.js';

export const frigateNamespace = {
  name: 'frigate', prefix: 'mcp__frigate__',
  description: 'Read-only Frigate investigation tools. Inspect structuredContent.ok before reporting observations.',
  instructions: 'Tool results preserve MCP content, structuredContent, and isError. Transport/harness failures may reject; handle both. No credentials are available in the sandbox.',
};

const TOOL_NAMES = Object.keys(toolManifests) as ToolName[];

const envelopeSchema = (outputSchema: Record<string, unknown>) => Type.Object({
  content: Type.Array(Type.Unknown(), { maxItems: 8 }),
  structuredContent: Type.Optional(Type.Unsafe(outputSchema)),
  isError: Type.Optional(Type.Boolean()),
}, { additionalProperties: true });

/** Durable-side arguments. Credentials, URLs, and camera scope stay operator-side. */
const toolParameters = {
  get_system_status: Type.Object({}, { additionalProperties: false }),
  list_cameras: Type.Object({ camera: Type.Optional(Type.String()) }, { additionalProperties: false }),
  get_capabilities: Type.Object({}, { additionalProperties: false }),
  list_events: Type.Object({
    after: Type.Number(),
    before: Type.Number(),
    cameras: Type.Optional(Type.Array(Type.String())),
    labels: Type.Optional(Type.Array(Type.String())),
    subLabels: Type.Optional(Type.Array(Type.String())),
    zones: Type.Optional(Type.Array(Type.String())),
    hasClip: Type.Optional(Type.Boolean()),
    hasSnapshot: Type.Optional(Type.Boolean()),
    inProgress: Type.Optional(Type.Boolean()),
    minScore: Type.Optional(Type.Number()),
    maxScore: Type.Optional(Type.Number()),
    limit: Type.Optional(Type.Number()),
    offset: Type.Optional(Type.Number()),
    sort: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  get_event: Type.Object({ eventId: Type.String() }, { additionalProperties: false }),
  search_events: Type.Object({
    query: Type.String(),
    after: Type.Number(),
    before: Type.Number(),
    cameras: Type.Optional(Type.Array(Type.String())),
    labels: Type.Optional(Type.Array(Type.String())),
    subLabels: Type.Optional(Type.Array(Type.String())),
    zones: Type.Optional(Type.Array(Type.String())),
    searchType: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
    offset: Type.Optional(Type.Number()),
  }, { additionalProperties: false }),
  list_review_items: Type.Object({
    after: Type.Number(),
    before: Type.Number(),
    cameras: Type.Optional(Type.Array(Type.String())),
    labels: Type.Optional(Type.Array(Type.String())),
    zones: Type.Optional(Type.Array(Type.String())),
    severity: Type.Optional(Type.String()),
    reviewed: Type.Optional(Type.Boolean()),
    limit: Type.Optional(Type.Number()),
  }, { additionalProperties: false }),
  get_review_item: Type.Object({ reviewId: Type.String() }, { additionalProperties: false }),
  get_recording_summary: Type.Object({ camera: Type.String() }, { additionalProperties: false }),
  list_recordings: Type.Object({
    camera: Type.String(),
    after: Type.Number(),
    before: Type.Number(),
  }, { additionalProperties: false }),
  get_latest_frame: Type.Object({ camera: Type.String() }, { additionalProperties: false }),
  get_event_image: Type.Object({
    eventId: Type.String(),
    kind: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
} as const;

/** Tools that answer with a bounded image block plus structured metadata. */
const MEDIA_TOOLS = new Set<ToolName>(['get_latest_frame', 'get_event_image']);

/**
 * A host-owned, optional bridge. Create again on host restart; persist only the
 * durable harness's state, never this client or its deployment environment.
 */
export async function connectFrigateStdio(parameters: StdioServerParameters) {
  const transport = new StdioClientTransport(parameters);
  const client = new Client({ name: 'frigate-durable-bridge', version: '0.6.0' });
  try {
    await client.connect(transport);
    const manifest = await client.listTools();
    const tools = TOOL_NAMES.map(name => {
      const advertised = manifest.tools.find(tool => tool.name === name);
      const expected = toolManifests[name];
      if (!advertised || !isDeepStrictEqual(advertised.inputSchema, expected.inputSchema)
        || !isDeepStrictEqual(advertised.outputSchema, expected.outputSchema)
        || advertised.annotations?.readOnlyHint !== true || advertised.annotations.destructiveHint !== false) {
        return undefined;
      }
      return advertised;
    });
    // The server must offer exactly the known read-only manifest.
    if (manifest.nextCursor || manifest.tools.length !== TOOL_NAMES.length || tools.some(tool => !tool)) {
      throw new Error('Incompatible Frigate read-only manifest');
    }
    const registered = TOOL_NAMES.map(name => {
      const expected = toolManifests[name];
      return defineTool({
        name: `mcp__frigate__${name}`,
        description: expected.description,
        parameters: toolParameters[name],
        structuredOutputSchema: envelopeSchema(expected.outputSchema),
        callers: ['tools'],
        replay: 'safe',
        execute: async (args, _api, context) => {
          try {
            const result = CallToolResultSchema.parse(await client.callTool({
              name,
              arguments: (args ?? {}) as Record<string, unknown>,
            }, undefined, {
              ...(context.abortSignal ? { signal: context.abortSignal } : {}),
              timeout: 65_000,
            }));
            const parsed = toolOutputSchemas[name].safeParse(result.structuredContent);
            if (!parsed.success || result.isError !== !parsed.data.ok) {
              throw new Error('Invalid MCP response');
            }
            const text = result.content.find(block => block.type === 'text');
            const images = result.content.filter(block => block.type === 'image');
            if (!text || text.type !== 'text' || text.text !== JSON.stringify(result.structuredContent)) {
              throw new Error('Invalid MCP response');
            }
            if (MEDIA_TOOLS.has(name)) {
              // Media tools answer with at most one bounded image block; the
              // structured result never carries the image bytes.
              if (images.length > 1) throw new Error('Invalid MCP response');
            } else if (result.content.length !== 1) {
              throw new Error('Invalid MCP response');
            }
            return {
              // The durable output stays text-only; a media tool's image block
              // stays in the structured envelope so a script can select it and
              // forward it with image() instead of printing base64.
              output: [{ type: 'text', text: text.text }],
              structuredOutput: JSON.parse(JSON.stringify(result)) as JsonObject,
              isError: result.isError === true,
            };
          } catch {
            // SDK/transport errors can contain remote responses or deployment details.
            throw new Error('Frigate MCP call failed, was cancelled, or returned an incompatible result');
          }
        },
      });
    });
    return {
      extension: defineExtension({ name: 'frigate-mcp', tools: registered }),
      close: () => client.close(),
      /** Useful for lifecycle supervision; never persisted or sent to the model. */
      get pid() { return transport.pid; },
    };
  } catch {
    await client.close().catch(() => undefined);
    throw new Error('Unable to connect to a compatible Frigate MCP server');
  }
}
