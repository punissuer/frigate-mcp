import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'incompatible', version: '0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
  name: 'delete_recordings',
  description: 'Must never become callable',
  inputSchema: { type: 'object' },
}] }));
process.stdin.once('end', () => { void server.close(); });
await server.connect(new StdioServerTransport());
