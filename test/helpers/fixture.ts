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

// Object events modeled on Frigate v0.18.2's EventResponse. Descriptions and
// other free text are sentinel values that must never be returned.
export const events = [
  {
    id: '1700000000.100000', camera: 'front', label: 'person', sub_label: 'adult', zones: ['porch'],
    start_time: 1700000000.1, end_time: 1700000010.25, has_clip: true, has_snapshot: true,
    retain_indefinitely: false, plus_id: null, top_score: 0.92, false_positive: false,
    data: { score: 0.92, average_estimated_speed: 1.4, description: 'SECRET person description' },
  },
  {
    id: '1700000100.200000', camera: 'front', label: 'car', sub_label: null, zones: ['driveway'],
    start_time: 1700000100.2, end_time: 1700000105.5, has_clip: false, has_snapshot: true,
    retain_indefinitely: false, plus_id: null, top_score: 0.75, false_positive: false,
    data: { score: 0.75, average_estimated_speed: 3.2, description: 'SECRET car description' },
  },
  {
    id: '1700000200.300000', camera: 'back', label: 'person', sub_label: null, zones: ['alley'],
    start_time: 1700000200.3, end_time: 1700000210.9, has_clip: true, has_snapshot: false,
    retain_indefinitely: false, plus_id: null, top_score: 0.6, false_positive: false,
    data: { score: 0.6, average_estimated_speed: 0.8, description: 'SECRET back description' },
  },
];

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
  events?: Record<string, unknown>[];
  /** Cameras the modelled account may read, as Frigate's role filtering does. */
  allowedCameras?: string[];
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
    const path = new URL(req.url ?? '/', 'http://fixture.invalid').pathname;
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
    } else if (path === '/nvr/api/events') {
      if (!authorized(req)) { unauthorized(res); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(selectEvents(req, settings)));
    } else if (path.startsWith('/nvr/api/events/')) {
      if (!authorized(req)) { unauthorized(res); return; }
      const id = decodeURIComponent(path.slice('/nvr/api/events/'.length));
      const allowed = settings.allowedCameras ?? settings.events?.map(event => String(event.camera)) ?? events.map(event => event.camera);
      const found = (settings.events ?? events).find(event => event.id === id);
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Event not found' }));
        return;
      }
      if (!allowed.includes(String(found.camera))) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Access denied' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(found));
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

/** Model Frigate v0.18.2's /events filtering, ordering, and offset paging. */
function selectEvents(req: IncomingMessage, settings: FixtureOptions): Record<string, unknown>[] {
  const url = new URL(req.url ?? '/', 'http://fixture.invalid');
  const query = url.searchParams;
  const allowed = settings.allowedCameras ?? (settings.events ?? events).map(event => String(event.camera));
  const cameras = query.get('cameras');
  const labels = query.get('labels');
  const zones = query.get('zones');
  const after = query.get('after') ? Number(query.get('after')) : undefined;
  const before = query.get('before') ? Number(query.get('before')) : undefined;
  const hasClip = query.get('has_clip');
  const hasSnapshot = query.get('has_snapshot');
  const limit = query.get('limit') ? Number(query.get('limit')) : 100;
  const offset = query.get('offset') ? Number(query.get('offset')) : 0;
  const sort = query.get('sort') ?? 'date_desc';
  let selected = (settings.events ?? events).filter(event => {
    if (cameras && cameras !== 'all' && !cameras.split(',').includes(String(event.camera))) return false;
    if (!allowed.includes(String(event.camera))) return false;
    if (labels && labels !== 'all' && !labels.split(',').includes(String(event.label))) return false;
    if (zones && zones !== 'all' && !(event.zones as string[]).some(zone => zones.split(',').includes(zone))) return false;
    if (after !== undefined && !(Number(event.start_time) > after)) return false;
    if (before !== undefined && !(Number(event.start_time) < before)) return false;
    if (hasClip === '1' && event.has_clip !== true) return false;
    if (hasClip === '0' && event.has_clip !== false) return false;
    if (hasSnapshot === '1' && event.has_snapshot !== true) return false;
    if (hasSnapshot === '0' && event.has_snapshot !== false) return false;
    return true;
  });
  const score = (event: Record<string, unknown>) => Number((event.data as { score?: number } | undefined)?.score ?? 0);
  const speed = (event: Record<string, unknown>) => Number((event.data as { average_estimated_speed?: number } | undefined)?.average_estimated_speed ?? 0);
  selected = [...selected].sort((left, right) => {
    if (sort === 'date_asc') return Number(left.start_time) - Number(right.start_time);
    if (sort === 'score_asc') return score(left) - score(right);
    if (sort === 'score_desc') return score(right) - score(left);
    if (sort === 'speed_asc') return speed(left) - speed(right);
    if (sort === 'speed_desc') return speed(right) - speed(left);
    return Number(right.start_time) - Number(left.start_time);
  });
  return selected.slice(offset, offset + limit);
}
