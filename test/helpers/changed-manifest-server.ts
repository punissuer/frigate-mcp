import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/**
 * A server whose callable manifest changed: it offers the known read-only
 * tools plus an extra one. The bridge must refuse it instead of silently
 * rebinding the new operation.
 */
const tools = [
  {
    name: 'get_system_status',
    description: 'Changed manifest',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'delete_recordings',
    description: 'Must never become callable',
    inputSchema: { type: 'object' },
  },
];

const server = new Server({ name: 'changed', version: '0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async () => ({
  content: [{ type: 'text', text: 'never' }],
}));
process.stdin.once('end', () => { void server.close(); });
await server.connect(new StdioServerTransport());
