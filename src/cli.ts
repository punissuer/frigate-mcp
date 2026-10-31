#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { optionsFromEnv } from './config.js';
import { createFrigateServer } from './server.js';
import { startFrigateHttpServer } from './server-http.js';

try {
  const options = optionsFromEnv(process.env);
  if (process.env.FRIGATE_MCP_TRANSPORT === 'http') {
    const secret = process.env.FRIGATE_MCP_HTTP_SECRET;
    if (!secret) throw new Error('FRIGATE_MCP_HTTP_SECRET is required for the HTTP transport');
    const server = await startFrigateHttpServer({
      ...options,
      secret,
      host: process.env.FRIGATE_MCP_HTTP_HOST,
      port: process.env.FRIGATE_MCP_HTTP_PORT ? Number(process.env.FRIGATE_MCP_HTTP_PORT) : undefined,
      path: process.env.FRIGATE_MCP_HTTP_PATH,
      allowedOrigins: process.env.FRIGATE_MCP_HTTP_ALLOWED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean),
      sessionTtlMs: process.env.FRIGATE_MCP_HTTP_SESSION_TTL_MS ? Number(process.env.FRIGATE_MCP_HTTP_SESSION_TTL_MS) : undefined,
      maxSessions: process.env.FRIGATE_MCP_HTTP_MAX_SESSIONS ? Number(process.env.FRIGATE_MCP_HTTP_MAX_SESSIONS) : undefined,
    });
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await server.close();
    };
    process.once('SIGINT', () => { void close(); });
    process.once('SIGTERM', () => { void close(); });
  } else {
    const server = createFrigateServer(options);
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
  }
} catch {
  // Configuration/parser/transport errors can carry deployment secrets. Never echo them.
  process.stderr.write('frigate-mcp: startup failed; check API-root, credentials, and policy configuration\n');
  process.exitCode = 1;
}
