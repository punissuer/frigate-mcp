import { isDeepStrictEqual } from 'node:util';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { arr, bool, num, obj, opt, str, unknown, type Schema } from '@earendil-works/pi-schema';
import { defineExtension, defineTool, type JsonObject } from '@earendil-works/pi-durable';
import { toolManifests, toolOutputSchemas, type ToolName } from './contract.js';

export const frigateNamespace = {
  name: 'frigate', prefix: 'mcp__frigate__',
  description: 'Read-only Frigate investigation tools. Inspect structuredContent.ok before reporting observations.',
  instructions: 'Tool results preserve MCP content, structuredContent, and isError. Transport/harness failures may reject; handle both. No credentials are available in the sandbox.',
};

const TOOL_NAMES = Object.keys(toolManifests) as ToolName[];

const envelopeSchema = (outputSchema: Record<string, unknown>) => obj({
  content: arr(unknown(), { maxItems: 8 }),
  structuredContent: opt(outputSchema as Schema),
  isError: opt(bool()),
}, { open: true });

/** Durable-side arguments. Credentials, URLs, and camera scope stay operator-side. */
const toolParameters = {
  get_system_status: obj({}),
  list_cameras: obj({ camera: opt(str()) }),
  get_capabilities: obj({}),
  list_events: obj({
    after: num(),
    before: num(),
    cameras: opt(arr(str())),
    labels: opt(arr(str())),
    subLabels: opt(arr(str())),
    zones: opt(arr(str())),
    hasClip: opt(bool()),
    hasSnapshot: opt(bool()),
    inProgress: opt(bool()),
    minScore: opt(num()),
    maxScore: opt(num()),
    limit: opt(num()),
    offset: opt(num()),
    sort: opt(str()),
  }),
  get_event: obj({ eventId: str() }),
  search_events: obj({
    query: str(),
    after: num(),
    before: num(),
    cameras: opt(arr(str())),
    labels: opt(arr(str())),
    subLabels: opt(arr(str())),
    zones: opt(arr(str())),
    searchType: opt(str()),
    limit: opt(num()),
    offset: opt(num()),
  }),
  list_review_items: obj({
    after: num(),
    before: num(),
    cameras: opt(arr(str())),
    labels: opt(arr(str())),
    zones: opt(arr(str())),
    severity: opt(str()),
    reviewed: opt(bool()),
    limit: opt(num()),
  }),
  get_review_item: obj({ reviewId: str() }),
  get_recording_summary: obj({ camera: str() }),
  list_recordings: obj({
    camera: str(),
    after: num(),
    before: num(),
  }),
  get_latest_frame: obj({ camera: str() }),
  get_event_image: obj({
    eventId: str(),
    kind: opt(str()),
  }),
  get_event_preview_gif: obj({ eventId: str() }),
  get_event_clip: obj({ eventId: str() }),
  get_recording_clip: obj({
    camera: str(),
    start: num(),
    end: num(),
  }),
} as const;

/** Tools that answer with a bounded image block plus structured metadata. */
const MEDIA_TOOLS = new Set<ToolName>(['get_latest_frame', 'get_event_image', 'get_event_preview_gif']);

/**
 * A host-owned, optional bridge. Create again on host restart; persist only the
 * durable harness's state, never this client or its deployment environment.
 */
export async function connectFrigateStdio(parameters: StdioServerParameters) {
  const transport = new StdioClientTransport(parameters);
  return connectFrigate(transport);
}

/**
 * The same bridge over a remote Streamable HTTP endpoint.
 *
 * The MCP bearer secret travels in the Authorization header only. The tool
 * contracts, the manifest validation, and the replay policy are identical to
 * the stdio bridge.
 */
export async function connectFrigateHttp(parameters: { url: string; secret: string; headers?: Record<string, string> }) {
  const transport = new StreamableHTTPClientTransport(new URL(parameters.url), {
    requestInit: {
      headers: {
        ...(parameters.headers ?? {}),
        authorization: `Bearer ${parameters.secret}`,
      },
    },
  });
  return connectFrigate(transport);
}

async function connectFrigate(transport: StdioClientTransport | StreamableHTTPClientTransport) {
  const client = new Client({ name: 'frigate-durable-bridge', version: '1.4.0' });
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
      get pid() { return ('pid' in transport ? transport.pid : undefined) ?? null; },
      /**
       * Retrieve an evidence artifact's bytes through the MCP resource URI the
       * clip tools returned. The server and the agent may run on different
       * hosts, so the bytes are fetched over the transport, never from a
       * server-local path.
       */
      async readArtifact(uri: string) {
        if (!/^frigate:\/\/artifact\/[a-f0-9]{32}$/.test(uri)) {
          throw new Error('Unknown Frigate artifact URI');
        }
        const result = await client.readResource({ uri });
        const contents = result.contents;
        if (contents.length !== 1) throw new Error('The artifact response was not a single resource');
        const content = contents[0]!;
        if (!('blob' in content) || content.mimeType !== 'video/mp4' || typeof content.blob !== 'string') {
          throw new Error('The artifact response was not a video');
        }
        return { mimeType: content.mimeType, byteLength: Buffer.byteLength(content.blob, 'base64'), blob: content.blob };
      },
    };
  } catch {
    await client.close().catch(() => undefined);
    throw new Error('Unable to connect to a compatible Frigate MCP server');
  }
}
