/**
 * A tiny Frigate-shaped HTTP fixture for the examples.
 *
 * It models the endpoints the examples read — `POST /login`, `GET /version`,
 * `GET /stats`, `GET /config`, and `GET /{camera}/latest.jpg` — with the
 * cookie-based session the real server uses. It exists so the examples run
 * offline, without a Frigate instance and without any credentials.
 */
import { createServer } from 'node:http';

export interface FixtureOptions {
  username?: string;
  password?: string;
  version?: string;
  cameras?: string[];
}

export interface Fixture {
  apiRoot: string;
  requests: { path: string; method: string }[];
  close(): Promise<void>;
}

export async function startFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const username = options.username ?? 'viewer';
  const password = options.password ?? 'offline-example-password';
  const version = options.version ?? '0.18.2';
  const cameras = options.cameras ?? ['front', 'back'];
  const requests: { path: string; method: string }[] = [];
  const token = 'offline-example-session-token';
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    requests.push({ path, method: req.method ?? 'GET' });
    const url = new URL(path, 'http://fixture.invalid');
    const authorized = (req.headers.cookie ?? '').includes(`frigate_token=${token}`)
      || (req.headers.authorization ?? '') === `Bearer ${token}`;
    if (url.pathname.endsWith('/login')) {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        let parsed: { user?: string; password?: string } = {};
        try { parsed = JSON.parse(body); } catch { parsed = {}; }
        if (parsed.user !== username || parsed.password !== password) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Login failed' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `frigate_token=${token}; Path=/; HttpOnly` });
        res.end('');
      });
      return;
    }
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Authentication required' }));
      return;
    }
    if (url.pathname.endsWith('/') && !url.pathname.includes('/latest')) {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Frigate is running. Alive and healthy!');
    } else if (url.pathname.endsWith('/version')) {
      res.setHeader('content-type', 'text/plain');
      res.end(version);
    } else if (url.pathname.endsWith('/stats')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        cameras: Object.fromEntries(cameras.map(camera => [camera, { camera_fps: 5, detection_fps: 2, detection_enabled: true }])),
        detectors: { coral: { inference_speed: 8.5 } },
        service: { uptime: 1234, last_updated: Math.floor(Date.now() / 1000) },
      }));
    } else if (url.pathname.endsWith('/config')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        cameras: Object.fromEntries(cameras.map(camera => [camera, { zones: { front_zone: { name: 'front_zone' } }, detect: { enabled: true } }])),
        tracked_objects: [{ label: 'person' }],
      }));
    } else if (url.pathname.endsWith('/latest.jpg')) {
      res.setHeader('content-type', 'image/jpeg');
      res.end(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fixture did not bind');
  return {
    apiRoot: `http://127.0.0.1:${address.port}/api`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
