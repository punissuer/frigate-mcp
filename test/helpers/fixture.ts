import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// Frigate v0.18.2's tagged app.py and stats/util.py contract. Sentinel fields
// deliberately model secrets/unsafe fields that must not leave the server.
export const statistics = {
  cameras: { front: { camera_fps: 5, process_fps: 5, skipped_fps: 0, detection_fps: 2, detection_enabled: true, ffmpeg_pid: 456, rtsp_url: 'rtsp://SECRET@camera' } },
  detectors: { coral: { inference_speed: 8.5, pid: 123 } },
  service: { uptime: 1234, last_updated: 1793448000, storage: { '/PRIVATE/path': { free: 10 } }, version: '0.18.2' },
  cpu_usages: { '123': { cmdline: 'ffmpeg SECRET' } },
  arbitrary: 'SECRET',
};
export type Override = (req: IncomingMessage, res: ServerResponse) => boolean;
export async function startFixture(override?: Override) {
  const requests: { path: string; method: string; authorization: string | undefined }[] = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url ?? '', method: req.method ?? '', authorization: req.headers.authorization });
    if (override?.(req, res)) return;
    if (req.url === '/nvr/api/') {
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end('Frigate is running. Alive and healthy!');
    } else if (req.url === '/nvr/api/version') {
      res.setHeader('content-type', 'text/plain');
      res.end('0.18.2');
    } else if (req.url === '/nvr/api/stats') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(statistics));
    } else { res.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  return {
    apiRoot: `http://127.0.0.1:${address.port}/nvr/api`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
