import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

// Frigate v0.18.2's tagged app.py, auth.py and stats/util.py contract. Sentinel
// fields deliberately model secrets/unsafe fields that must not leave the server.
export const statistics = {
  cameras: { front: { camera_fps: 5, process_fps: 5, skipped_fps: 0, detection_fps: 2, detection_enabled: true, ffmpeg_pid: 456, rtsp_url: 'rtsp://SECRET@camera' } },
  detectors: { coral: { inference_speed: 8.5, pid: 123 } },
  service: { uptime: 1234, last_updated: 1793448000, storage: { '/PRIVATE/path': { free: 10 } }, version: '0.18.2' },
  cpu_usages: { '123': { cmdline: 'ffmpeg SECRET' } },
  arbitrary: 'SECRET',
};

// GET /config returns the whole Frigate configuration. Only allowlisted fields
// may leave the MCP server.
export const configuration = {
  cameras: {
    front: {
      ffmpeg: { inputs: [{ path: 'rtsp://SECRET@front' }], cmds: ['ffmpeg -i rtsp://SECRET@front'] },
      detect: { enabled: true },
      objects: { track: ['person'] },
      zones: { porch: { name: 'porch', coordinates: 'SECRET' }, driveway: { name: 'driveway', coordinates: 'SECRET' } },
    },
    back: {
      ffmpeg: { inputs: [{ path: 'rtsp://SECRET@back' }] },
      detect: { enabled: false },
      zones: { alley: { name: 'alley', coordinates: 'SECRET' } },
    },
  },
  tracked_objects: [{ label: 'person' }, { label: 'car' }],
  detectors: { coral: { device: 'SECRET', api_key: 'SECRET' } },
  mqtt: { host: 'SECRET', password: 'SECRET' },
  environment_vars: { SECRET: 'SECRET' },
  record: { enabled: true, path: '/PRIVATE/path' },
};

export type Override = (req: IncomingMessage, res: ServerResponse) => boolean;

export interface FixtureOptions {
  version?: string;
  /** Require a valid session cookie or bearer token for protected endpoints. */
  requireAuth?: boolean;
  credentials?: { user: string; password: string };
  authCookieName?: string;
  /** Bearer token accepted for externally supplied credentials. */
  bearerToken?: string;
  /** Reject every issued session, as an expired or revoked credential would. */
  expireSessions?: boolean;
  config?: Record<string, unknown>;
  stats?: Record<string, unknown>;
  /** Serve HTTPS with an operator-supplied certificate. */
  tls?: { key: Buffer; cert: Buffer };
  /** Extra behavior layered on top of the modeled routes. */
  override?: Override;
}

export interface RecordedRequest {
  path: string;
  method: string;
  authorization: string | undefined;
  cookie: string | undefined;
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A JWT-shaped session token. The fixture never verifies signatures. */
export function sessionToken(user: string, expiresInSeconds = 86_400): string {
  const now = Math.floor(Date.now() / 1000);
  return `${base64url({ alg: 'HS256', typ: 'JWT' })}.${base64url({ sub: user, role: 'viewer', iat: now, exp: now + expiresInSeconds })}.signature`;
}

export async function startFixture(options: FixtureOptions | Override = {}) {
  const settings: FixtureOptions = typeof options === 'function' ? { override: options } : options;
  const version = settings.version ?? '0.18.2';
  const cookieName = settings.authCookieName ?? 'frigate_token';
  const token = sessionToken(settings.credentials?.user ?? 'viewer');
  const requests: RecordedRequest[] = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    requests.push({
      path: req.url ?? '',
      method: req.method ?? '',
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    if (settings.override?.(req, res)) return;
    const path = req.url ?? '';
    if (path === '/nvr/api/' ) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Frigate is running. Alive and healthy!');
    } else if (path === '/nvr/api/version') {
      res.setHeader('content-type', 'text/plain');
      res.end(version);
    } else if (path === '/nvr/api/stats') {
      if (!authorized(req)) { unauthorized(res); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(settings.stats ?? statistics));
    } else if (path === '/nvr/api/config') {
      if (!authorized(req)) { unauthorized(res); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(settings.config ?? configuration));
    } else if (path === '/nvr/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed: { user?: unknown; password?: unknown } = {};
      try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = {}; }
      const expected = settings.credentials;
      if (!expected || parsed.user !== expected.user || parsed.password !== expected.password) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Login failed' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `${cookieName}=${token}; Path=/; HttpOnly; Max-Age=86400` });
      res.end('');
    } else { res.writeHead(404).end(); }
  };
  const server = settings.tls
    ? createHttpsServer({ key: settings.tls.key, cert: settings.tls.cert }, handler)
    : createHttpServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const scheme = settings.tls ? 'https' : 'http';
  return {
    apiRoot: `${scheme}://127.0.0.1:${address.port}/nvr/api`,
    requests,
    token,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };

  function authorized(req: IncomingMessage): boolean {
    if (!settings.requireAuth) return true;
    if (settings.expireSessions) return false;
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined;
    if (bearer && (bearer === token || (settings.bearerToken && bearer === settings.bearerToken))) return true;
    const cookie = req.headers.cookie?.split(';').map(entry => entry.trim()).find(entry => entry.startsWith(`${cookieName}=`));
    if (cookie && cookie.slice(cookieName.length + 1) === token) return true;
    return false;
  }

  function unauthorized(res: ServerResponse) {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Authentication required' }));
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}
