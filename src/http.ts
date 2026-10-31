import { readFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';

export type TransportFailureKind = 'timeout' | 'cancelled' | 'unreachable' | 'payload_too_large';

/** Transport-level failure. Never carries upstream bodies, URLs with credentials, or headers. */
export class TransportError extends Error {
  constructor(readonly kind: TransportFailureKind, message: string) { super(message); }
}

export interface HttpRequest {
  url: URL;
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer;
  signal: AbortSignal;
  maxBytes: number;
  /** Operator-supplied CA bundle for a private TLS deployment. */
  ca?: Buffer;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Read an operator-supplied PEM CA file. TLS verification always stays enabled. */
export function loadCaCertificate(path: string): Buffer {
  let pem: Buffer;
  try { pem = readFileSync(path); }
  catch { throw new Error('FRIGATE_CA_CERT_FILE must be a readable PEM certificate file'); }
  if (!/-----BEGIN CERTIFICATE-----/.test(pem.toString('utf8'))) {
    throw new Error('FRIGATE_CA_CERT_FILE must contain a PEM certificate');
  }
  return pem;
}

/**
 * Minimal HTTP(S) client used for every upstream read.
 *
 * It never follows redirects, never negotiates credentials, enforces the byte
 * limit while streaming, and honours cancellation. TLS verification stays on;
 * only an operator-supplied CA is added to the trust store.
 */
export async function performRequest(options: HttpRequest): Promise<HttpResponse> {
  const { url, signal, maxBytes } = options;
  if (signal.aborted) throw new TransportError('cancelled', 'Upstream request cancelled');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TransportError('unreachable', 'Unsupported upstream protocol');
  }
  const secure = url.protocol === 'https:';
  return new Promise<HttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; action(); } };
    const fail = (error: Error) => finish(() => reject(error));
    const request = secure ? httpsRequest : httpRequest;
    const requestOptions = {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      ...(secure ? { ca: options.ca, servername: url.hostname, rejectUnauthorized: true } : {}),
    };
    const req = request(requestOptions, res => {
      const status = res.statusCode ?? 0;
      const declared = Number(res.headers['content-length'] ?? '0');
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        fail(new TransportError('payload_too_large', 'Upstream response exceeded the byte limit'));
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.destroy();
          fail(new TransportError('payload_too_large', 'Upstream response exceeded the byte limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish(() => resolve({ status, headers: res.headers, body: Buffer.concat(chunks) })));
      res.on('error', () => fail(new TransportError(signal.aborted ? 'cancelled' : 'unreachable', 'Upstream response failed')));
    });
    req.on('error', () => {
      if (signal.aborted) {
        fail(new TransportError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'Upstream request cancelled'));
        return;
      }
      fail(new TransportError('unreachable', 'Unable to reach Frigate'));
    });
    signal.addEventListener('abort', () => {
      req.destroy();
      fail(new TransportError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'Upstream request cancelled'));
    }, { once: true });
    if (options.body) req.write(options.body);
    req.end();
  });
}
