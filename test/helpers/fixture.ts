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

// A tiny JPEG-like payload. The fixture only needs the declared MIME type and
// a bounded body; no decoder reads it.
export const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

// Review segments modeled on Frigate v0.18.2's ReviewSegmentResponse. Review
// times are ISO 8601 strings without a zone offset, as FastAPI serializes them.
export const reviewItems = [
  {
    id: '1700000000.100000-review', camera: 'front', start_time: '2023-11-14T22:13:20.000000', end_time: '2023-11-14T22:13:30.000000',
    has_been_reviewed: false, severity: 'alert', thumb_path: '/media/front/1700000000.100000.jpg',
    data: { zones: ['porch'], detections: ['1700000000.100000'], objects: [{ id: '1700000000.100000', label: 'person' }] },
  },
  {
    id: '1700000100.200000-review', camera: 'front', start_time: '2023-11-14T22:28:20.000000', end_time: '2023-11-14T22:28:25.000000',
    has_been_reviewed: true, severity: 'detection', thumb_path: '/media/front/1700000100.200000.jpg',
    data: { zones: ['driveway'], detections: ['1700000100.200000'], objects: [] },
  },
  {
    id: '1700000200.300000-review', camera: 'back', start_time: '2023-11-14T21:43:20.000000', end_time: '2023-11-14T21:43:30.000000',
    has_been_reviewed: false, severity: 'alert', thumb_path: '/media/back/1700000200.300000.jpg',
    data: { zones: ['alley'], detections: ['1700000200.300000'], objects: [] },
  },
];

// Recording intervals modeled on Frigate v0.18.2's /{camera}/recordings rows.
export const recordingIntervals = {
  front: [
    { id: '1700000000', start_time: 1700000000, end_time: 1700000060, segment_size: 60, motion: 12, objects: 3, duration: 60 },
    { id: '1700000120', start_time: 1700000120, end_time: 1700000180, segment_size: 60, motion: 4, objects: 1, duration: 60 },
  ],
  back: [
    { id: '1700000000', start_time: 1700000000, end_time: 1700000030, segment_size: 60, motion: 1, objects: 0, duration: 30 },
  ],
};

export const recordingSummaries = {
  front: [
    {
      day: '2023-11-14', events: 2,
      hours: [{ hour: '22', events: 2, motion: 16, objects: 4, duration: 120 }],
    },
  ],
  back: [
    {
      day: '2023-11-14', events: 1,
      hours: [{ hour: '22', events: 1, motion: 1, objects: 0, duration: 30 }],
    },
  ],
};

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
  /** Model Frigate's semantic search service. */
  semanticSearch?: { enabled: boolean; matches?: Record<string, unknown>[] };
  reviews?: Record<string, unknown>[];
  recordings?: Record<string, Record<string, unknown>[]>;
  recordingSummaries?: Record<string, Record<string, unknown>[]>;
  /** Model camera availability for latest-frame requests. */
  cameras?: {
    /** Cameras that answer with a stored preview instead of a live frame. */
    offline?: string[];
    /** Cameras with no frame at all. */
    missing?: string[];
    /** Cameras whose latest frame is served with a different MIME type. */
    wrongMime?: string[];
  };
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
    } else if (/^\/nvr\/api\/[A-Za-z0-9_-]+\/latest\.jpg$/.test(path)) {
      if (!authorized(req)) { unauthorized(res); return; }
      const camera = path.split('/')[3]!;
      const cameras = settings.cameras ?? {};
      if (cameras.missing?.includes(camera)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Camera not found' }));
        return;
      }
      if (cameras.wrongMime?.includes(camera)) {
        res.setHeader('content-type', 'text/html');
        res.end('<html>SECRET</html>');
        return;
      }
      res.setHeader('content-type', 'image/jpeg');
      if (cameras.offline?.includes(camera)) res.setHeader('x-frigate-offline', 'true');
      res.end(jpegBytes);
    } else if (/^\/nvr\/api\/events\/[A-Za-z0-9_.-]+\/(snapshot|thumbnail)\.jpg$/.test(path)) {
      if (!authorized(req)) { unauthorized(res); return; }
      const id = decodeURIComponent(path.split('/')[4]!);
      const kind = path.split('/')[5]!.replace('.jpg', '');
      const found = (settings.events ?? events).find(event => event.id === id);
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Event not found' }));
        return;
      }
      if (kind === 'snapshot' && found.has_snapshot !== true) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Snapshot not available' }));
        return;
      }
      res.setHeader('content-type', 'image/jpeg');
      res.end(jpegBytes);
    } else if (path === '/nvr/api/review') {
      if (!authorized(req)) { unauthorized(res); return; }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(selectReviews(req, settings)));
    } else if (path.startsWith('/nvr/api/review/')) {
      if (!authorized(req)) { unauthorized(res); return; }
      const id = decodeURIComponent(path.slice('/nvr/api/review/'.length));
      const allowed = settings.allowedCameras ?? (settings.reviews ?? reviewItems).map(review => String(review.camera));
      const found = (settings.reviews ?? reviewItems).find(review => review.id === id);
      if (!found) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Review item not found' }));
        return;
      }
      if (!allowed.includes(String(found.camera))) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Access denied' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(found));
    } else if (/^\/nvr\/api\/[A-Za-z0-9_-]+\/recordings\/summary$/.test(path)) {
      if (!authorized(req)) { unauthorized(res); return; }
      const camera = path.split('/')[3]!;
      const allowed = settings.allowedCameras ?? Object.keys(settings.recordings ?? recordingIntervals);
      if (!allowed.includes(camera)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Access denied' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(((settings.recordingSummaries ?? recordingSummaries) as Record<string, Record<string, unknown>[]>)[camera] ?? []));
    } else if (/^\/nvr\/api\/[A-Za-z0-9_-]+\/recordings$/.test(path)) {
      if (!authorized(req)) { unauthorized(res); return; }
      const camera = path.split('/')[3]!;
      const allowed = settings.allowedCameras ?? Object.keys(settings.recordings ?? recordingIntervals);
      if (!allowed.includes(camera)) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Access denied' }));
        return;
      }
      const url = new URL(req.url ?? '/', 'http://fixture.invalid');
      const after = url.searchParams.get('after') ? Number(url.searchParams.get('after')) : undefined;
      const before = url.searchParams.get('before') ? Number(url.searchParams.get('before')) : undefined;
      const intervals = (((settings.recordings ?? recordingIntervals) as Record<string, Record<string, unknown>[]>)[camera] ?? [])
        .filter((record: Record<string, unknown>) => (after === undefined || Number(record.end_time) >= after) && (before === undefined || Number(record.start_time) <= before));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(intervals));
    } else if (path === '/nvr/api/events/search') {
      if (!authorized(req)) { unauthorized(res); return; }
      const search = settings.semanticSearch ?? { enabled: false };
      if (!search.enabled) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: false, message: 'Semantic search is not enabled' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url ?? '/', 'http://fixture.invalid');
      const limit = url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : 50;
      const offset = url.searchParams.get('offset') ? Number(url.searchParams.get('offset')) : 0;
      res.end(JSON.stringify((search.matches ?? []).slice(offset, offset + limit)));
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

/** Model Frigate v0.18.2's /review filtering and ordering. */
function selectReviews(req: IncomingMessage, settings: FixtureOptions): Record<string, unknown>[] {
  const url = new URL(req.url ?? '/', 'http://fixture.invalid');
  const query = url.searchParams;
  const allowed = settings.allowedCameras ?? (settings.reviews ?? reviewItems).map(review => String(review.camera));
  const cameras = query.get('cameras');
  const labels = query.get('labels');
  const zones = query.get('zones');
  const severity = query.get('severity');
  const reviewed = query.get('reviewed');
  const after = query.get('after') ? Number(query.get('after')) : undefined;
  const before = query.get('before') ? Number(query.get('before')) : undefined;
  const limit = query.get('limit') ? Number(query.get('limit')) : undefined;
  const selected = (settings.reviews ?? reviewItems).filter(review => {
    if (!allowed.includes(String(review.camera))) return false;
    if (cameras && cameras !== 'all' && !cameras.split(',').includes(String(review.camera))) return false;
    if (severity && review.severity !== severity) return false;
    if (reviewed === '1' && review.has_been_reviewed !== true) return false;
    if (reviewed === '0' && review.has_been_reviewed === true) return false;
    const start = Date.parse(String(review.start_time).replace(' ', 'T') + 'Z') / 1000;
    if (after !== undefined && !(start > after)) return false;
    if (before !== undefined && !(start < before)) return false;
    const data = review.data as { zones?: string[]; detections?: unknown[] } | undefined;
    if (labels && labels !== 'all' && !labels.split(',').some(label => (data?.detections ?? []).includes(label))) return false;
    if (zones && zones !== 'all' && !zones.split(',').some(zone => (data?.zones ?? []).includes(zone))) return false;
    return true;
  });
  const ordered = [...selected].sort((left, right) =>
    String(left.severity).localeCompare(String(right.severity))
    || Date.parse(String(right.start_time).replace(' ', 'T') + 'Z') - Date.parse(String(left.start_time).replace(' ', 'T') + 'Z'));
  return limit ? ordered.slice(0, limit) : ordered;
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
