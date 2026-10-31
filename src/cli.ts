#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { optionsFromEnv } from './config.js';
import { createFrigateServer } from './server.js';

try {
  const server = createFrigateServer(optionsFromEnv(process.env));
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await server.close();
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.stdin.once('end', () => { void close(); });
  await server.connect(transport);
} catch {
  // Configuration/parser/transport errors can carry deployment secrets. Never echo them.
  process.stderr.write('frigate-mcp: startup failed; check API-root, credentials, and policy configuration\n');
  process.exitCode = 1;
}
