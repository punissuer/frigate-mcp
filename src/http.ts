import { readFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';

export type TransportFailureKind =
  | 'timeout'
  | 'cancelled'
  | 'unreachable'
  | 'payload_too_large'
  /** The server certificate is not signed by a trusted authority. */
  | 'certificate_trust'
  /** The server certificate does not match the host we asked for. */
  | 'certificate_hostname'
  /** A pinned certificate was configured, and the server presented another one. */
  | 'certificate_pin';

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
  /**
   * Pin one exact server certificate. That certificate becomes the only trusted
   * anchor and the hostname is not verified against it, which is what a
   * self-signed certificate with a wildcard common name requires.
   */
  pinCertificate?: Buffer;
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

export interface StreamRequest {
  url: URL;
  headers?: Record<string, string>;
  signal: AbortSignal;
  maxBytes: number;
  destination: string;
  ca?: Buffer;
  pinCertificate?: Buffer;
}

/** Classify a TLS failure so the operator gets an actionable answer. */
export function tlsFailureKind(error: unknown): 'certificate_trust' | 'certificate_hostname' | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'certificate_hostname';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_GET_ISSUER_CERT':
    case 'CERT_SIGNATURE_FAILURE':
    case 'ERR_TLS_CERT_SIGNATURE_FAILURE':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_EXPIRED':
      return 'certificate_trust';
    default:
      return undefined;
  }
}

/** The TLS options for one request: trust store, optional pin, hostname check. */
function tlsOptions(url: URL, options: { ca?: Buffer; pinCertificate?: Buffer }) {
  const pinned = Boolean(options.pinCertificate);
  return {
    ...(options.pinCertificate ? { ca: options.pinCertificate } : options.ca ? { ca: options.ca } : {}),
    // A wildcard common name cannot match a host, so a pinned certificate is
    // trusted as-is and the hostname check is skipped for it.
    ...(pinned ? { checkServerIdentity: () => undefined } : {}),
    ...(isIpAddress(url.hostname) ? {} : { servername: url.hostname }),
    rejectUnauthorized: true,
  };
}

function isIpAddress(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(':');
}

/**
 * Stream an upstream response into a file without buffering it in memory.
 *
 * The byte limit is enforced while streaming: an oversized response is cut
 * off and the partial file is removed by the caller.
 */
export async function streamToFile(options: StreamRequest): Promise<{ status: number; headers: IncomingHttpHeaders; bytes: number }> {
  const { url, signal, maxBytes, destination } = options;
  if (signal.aborted) throw new TransportError('cancelled', 'Upstream request cancelled');
  const secure = url.protocol === 'https:';
  const request = secure ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => { if (!settled) { settled = true; action(); } };
    const fail = (error: Error) => finish(() => reject(error));
    const req = request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || (secure ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: options.headers ?? {},
      ...(secure ? tlsOptions(url, options) : {}),
    }, res => {
      const status = res.statusCode ?? 0;
      const declared = Number(res.headers['content-length'] ?? '0');
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy();
        fail(new TransportError('payload_too_large', 'Upstream media exceeded the media byte limit'));
        return;
      }
      let bytes = 0;
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          res.destroy();
          fail(new TransportError('payload_too_large', 'Upstream media exceeded the media byte limit'));
        }
      });
      const sink = createWriteStream(destination, { mode: 0o600 });
      pipeline(res, sink).then(() => {
        if (bytes > maxBytes) {
          fail(new TransportError('payload_too_large', 'Upstream media exceeded the media byte limit'));
          return;
        }
        finish(() => resolve({ status, headers: res.headers, bytes }));
      }).catch(() => {
        fail(new TransportError(signal.aborted ? 'cancelled' : 'unreachable', 'Upstream media download failed'));
      });
    });
    req.on('error', (error: unknown) => {
      if (signal.aborted) {
        fail(new TransportError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'Upstream request cancelled'));
        return;
      }
      const tls = tlsFailureKind(error);
      if (tls) {
        // With a pin configured, a trust failure means the server presented a
        // different certificate than the pinned one.
        const kind = tls === 'certificate_trust' && options.pinCertificate ? 'certificate_pin' : tls;
        fail(new TransportError(kind, kind === 'certificate_hostname'
          ? 'The Frigate certificate does not match this host'
          : kind === 'certificate_pin'
            ? 'The pinned certificate does not match the server certificate'
            : 'The Frigate certificate is not trusted'));
        return;
      }
      fail(new TransportError('unreachable', 'Unable to reach Frigate'));
    });
    signal.addEventListener('abort', () => {
      req.destroy();
      fail(new TransportError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'Upstream request cancelled'));
    }, { once: true });
    req.end();
  });
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
      ...(secure ? tlsOptions(url, options) : {}),
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
    req.on('error', (error: unknown) => {
      if (signal.aborted) {
        fail(new TransportError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled', 'Upstream request cancelled'));
        return;
      }
      const tls = tlsFailureKind(error);
      if (tls) {
        // With a pin configured, a trust failure means the server presented a
        // different certificate than the pinned one.
        const kind = tls === 'certificate_trust' && options.pinCertificate ? 'certificate_pin' : tls;
        fail(new TransportError(kind, kind === 'certificate_hostname'
          ? 'The Frigate certificate does not match this host'
          : kind === 'certificate_pin'
            ? 'The pinned certificate does not match the server certificate'
            : 'The Frigate certificate is not trusted'));
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
