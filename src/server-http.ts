import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createFrigateServer } from './server.js';
import type { FrigateOptions } from './config.js';

export interface HttpServerOptions {
  /** Interface to bind. Loopback by default. */
  host?: string | undefined;
  port?: number | undefined;
  /** MCP endpoint path. */
  path?: string | undefined;
  /** High-entropy bearer secret, distinct from the Frigate credential. */
  secret: string;
  /** Origins allowed to call the endpoint. Empty means "no Origin check". */
  allowedOrigins?: string[] | undefined;
  /** Maximum session lifetime in milliseconds. */
  sessionTtlMs?: number | undefined;
  /** Maximum number of concurrent sessions. */
  maxSessions?: number | undefined;
  /** Maximum accepted request body size in bytes. */
  maxRequestBytes?: number | undefined;
}

interface Session {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: ReturnType<typeof createFrigateServer>;
  createdAt: number;
}

/** Constant-time comparison of two secrets without leaking their length. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * A Streamable HTTP MCP server.
 *
 * Every request must carry the MCP bearer secret, which is distinct from the
 * Frigate credential. Sessions are bounded in number and lifetime, request
 * bodies are bounded in size, and the Origin header is validated when the
 * operator lists allowed origins. The tool contracts, camera scope, and
 * policy checks are exactly the ones the stdio server applies.
 */
export async function startFrigateHttpServer(options: FrigateOptions & HttpServerOptions) {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8080;
  const path = options.path ?? '/mcp';
  const secret = options.secret;
  const allowedOrigins = options.allowedOrigins ?? [];
  const sessionTtlMs = options.sessionTtlMs ?? 30 * 60 * 1000;
  const maxSessions = options.maxSessions ?? 16;
  const maxRequestBytes = options.maxRequestBytes ?? 1024 * 1024;
  if (!secret || secret.length < 32) {
    throw new Error('The MCP HTTP secret must be at least 32 characters of high-entropy material');
  }
  if (!host.includes('127.0.0.1') && !host.includes('::1') && !host.includes('localhost')) {
    // A non-loopback bind is an explicit operator decision; it is allowed but
    // must be paired with TLS at the service or a trusted ingress.
    if (!process.env.FRIGATE_MCP_HTTP_ALLOW_NON_LOOPBACK) {
      throw new Error('Binding a non-loopback address requires FRIGATE_MCP_HTTP_ALLOW_NON_LOOPBACK=true');
    }
  }
  const sessions = new Map<string, Session>();

  const closeExpired = () => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.createdAt > sessionTtlMs) {
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
        void session.server.close().catch(() => undefined);
      }
    }
  };

  const deny = (res: ServerResponse, status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) { deny(res, 404, 'Not found'); return; }
      const authorization = req.headers.authorization ?? '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
      if (!token || !secretsMatch(token, secret)) {
        // The same answer for a missing and a wrong secret.
        res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (allowedOrigins.length > 0) {
        const origin = req.headers.origin;
        if (origin && !allowedOrigins.includes(origin)) {
          deny(res, 403, 'Origin not allowed');
          return;
        }
      }
      closeExpired();
      const sessionId = req.headers['mcp-session-id'];
      if (req.method === 'POST') {
        const length = Number(req.headers['content-length'] ?? '0');
        if (Number.isFinite(length) && length > maxRequestBytes) { deny(res, 413, 'Request too large'); return; }
        const body = await readBody(req, maxRequestBytes);
        if (!body.ok) { deny(res, 413, 'Request too large'); return; }
        let parsed: unknown;
        try { parsed = JSON.parse(body.text); }
        catch { deny(res, 400, 'Invalid JSON body'); return; }
        let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
        if (!session) {
          if (sessions.size >= maxSessions) { deny(res, 503, 'Too many sessions'); return; }
          session = await createSession();
        }
        await session.transport.handleRequest(req, res, parsed);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        if (typeof sessionId !== 'string' || !sessions.has(sessionId)) { deny(res, 404, 'Unknown session'); return; }
        const session = sessions.get(sessionId)!;
        if (req.method === 'DELETE') {
          sessions.delete(session.id);
          await session.transport.close().catch(() => undefined);
          await session.server.close().catch(() => undefined);
          res.writeHead(200).end();
          return;
        }
        await session.transport.handleRequest(req, res);
        return;
      }
      deny(res, 405, 'Method not allowed');
    } catch {
      // Never echo upstream or deployment details.
      if (!res.headersSent) deny(res, 500, 'Request failed');
      else res.end();
    }
  });

  async function createSession(): Promise<Session> {
    const id = randomUUID();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => id,
      onsessioninitialized: (sessionId: string) => { sessions.set(sessionId, session); },
    });
    const mcp = createFrigateServer(options);
    const session: Session = { id, transport, server: mcp, createdAt: Date.now() };
    await mcp.connect(transport);
    return session;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const address = server.address();
  const boundPort = address && typeof address !== 'string' ? address.port : port;
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${boundPort}${path}`,
    port: boundPort,
    sessions,
    async close() {
      for (const session of sessions.values()) {
        await session.transport.close().catch(() => undefined);
        await session.server.close().catch(() => undefined);
      }
      sessions.clear();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > maxBytes) return { ok: false };
    chunks.push(buffer);
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}
