import { loadCaCertificate } from './http.js';

export interface FrigateOptions {
  /** Exact API root, including any reverse-proxy prefix and /api. */
  apiRoot: string;
  bearerToken?: string | undefined;
  /** Managed session: Frigate username used with /login. */
  username?: string | undefined;
  /** Managed session: Frigate password used with /login. */
  password?: string | undefined;
  /** Frigate's configured JWT cookie name (`auth.cookie_name`). */
  authCookieName?: string | undefined;
  /** Operator camera allowlist. Empty means "no additional camera scope". */
  cameras?: string[] | undefined;
  /** PEM file with a private CA to trust in addition to the system store. */
  caCertFile?: string | undefined;
  /** Explicitly permit HTTP on a trusted private network (including the fixture). */
  allowInsecureHttp?: boolean | undefined;
  /** Explicitly permit running without credentials against a trusted network. */
  allowUnauthenticated?: boolean | undefined;
  timeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  maxConcurrent?: number | undefined;
  /** Default event page size. */
  eventsPageSize?: number | undefined;
  /** Maximum historical event window in seconds. */
  eventsMaxWindowSeconds?: number | undefined;
  /** Maximum serialized structured result size in bytes. */
  maxResultBytes?: number | undefined;
}

const CAMERA_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COOKIE_NAME = /^[a-z_]+$/;

export function validateOptions(options: FrigateOptions) {
  let url: URL;
  try { url = new URL(options.apiRoot); }
  catch { throw new Error('FRIGATE_API_ROOT must be an absolute HTTP(S) API-root URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('API root must use HTTP(S) without credentials, query, or fragment');
  }
  if (url.protocol === 'http:' && !options.allowInsecureHttp) {
    throw new Error('HTTP requires explicit FRIGATE_ALLOW_INSECURE_HTTP=true on a trusted network');
  }
  if (options.bearerToken !== undefined && !/^[\x21-\x7e]+$/.test(options.bearerToken)) {
    throw new Error('Bearer token must be a nonempty printable token without whitespace');
  }
  if ((options.username === undefined) !== (options.password === undefined)) {
    throw new Error('FRIGATE_USERNAME and FRIGATE_PASSWORD must be configured together');
  }
  if (options.username !== undefined && (!options.username || /[\r\n\0]/.test(options.username))) {
    throw new Error('Frigate username must be a nonempty single-line value');
  }
  if (options.password !== undefined && (!options.password || /[\r\n\0]/.test(options.password))) {
    throw new Error('Frigate password must be a nonempty single-line value');
  }
  const cookieName = options.authCookieName ?? 'frigate_token';
  if (!COOKIE_NAME.test(cookieName)) throw new Error('FRIGATE_AUTH_COOKIE_NAME must be a lowercase Frigate cookie name');
  const cameras = [...new Set(options.cameras ?? [])];
  if (cameras.length > 128) throw new Error('Too many cameras in FRIGATE_CAMERAS');
  for (const camera of cameras) {
    if (!CAMERA_ID.test(camera)) throw new Error('FRIGATE_CAMERAS must contain plain camera identifiers');
  }
  const ca = options.caCertFile === undefined ? undefined : loadCaCertificate(options.caCertFile);
  if (ca && url.protocol !== 'https:') throw new Error('FRIGATE_CA_CERT_FILE requires an HTTPS API root');
  const hasCredentials = Boolean(options.bearerToken) || Boolean(options.username);
  // Port 5000 is Frigate's internal interface and bypasses role enforcement.
  if (!hasCredentials && url.port === '5000' && !options.allowUnauthenticated) {
    throw new Error('Unauthenticated access to port 5000 requires explicit FRIGATE_TRUSTED_UNAUTHENTICATED=true');
  }
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  const limits = {
    timeoutMs: options.timeoutMs ?? 15_000,
    maxResponseBytes: options.maxResponseBytes ?? 5 * 1024 * 1024,
    maxConcurrent: options.maxConcurrent ?? 4,
    eventsPageSize: options.eventsPageSize ?? 50,
    eventsMaxWindowSeconds: options.eventsMaxWindowSeconds ?? 86_400,
    maxResultBytes: options.maxResultBytes ?? 256 * 1024,
  };
  const bounds: Record<string, number> = {
    timeoutMs: 60_000, maxResponseBytes: 5 * 1024 * 1024, maxConcurrent: 32,
    eventsPageSize: 200, eventsMaxWindowSeconds: 7 * 86_400, maxResultBytes: 1024 * 1024,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > (bounds[key] ?? 0)) {
      throw new Error(`Invalid ${key} policy limit`);
    }
  }
  return {
    ...limits,
    root: url,
    ca,
    cameras,
    cameraScopeRestricted: cameras.length > 0,
    bearerToken: options.bearerToken,
    username: options.username,
    password: options.password,
    cookieName,
  };
}

export function optionsFromEnv(env: NodeJS.ProcessEnv): FrigateOptions {
  if (!env.FRIGATE_API_ROOT) throw new Error('FRIGATE_API_ROOT is required (include /api)');
  const options: FrigateOptions = {
    apiRoot: env.FRIGATE_API_ROOT,
    allowInsecureHttp: env.FRIGATE_ALLOW_INSECURE_HTTP === 'true',
    allowUnauthenticated: env.FRIGATE_TRUSTED_UNAUTHENTICATED === 'true',
  };
  if (env.FRIGATE_BEARER_TOKEN !== undefined) options.bearerToken = env.FRIGATE_BEARER_TOKEN;
  if (env.FRIGATE_USERNAME !== undefined) options.username = env.FRIGATE_USERNAME;
  if (env.FRIGATE_PASSWORD !== undefined) options.password = env.FRIGATE_PASSWORD;
  if (env.FRIGATE_AUTH_COOKIE_NAME !== undefined) options.authCookieName = env.FRIGATE_AUTH_COOKIE_NAME;
  if (env.FRIGATE_CA_CERT_FILE !== undefined) options.caCertFile = env.FRIGATE_CA_CERT_FILE;
  if (env.FRIGATE_CAMERAS !== undefined) {
    options.cameras = env.FRIGATE_CAMERAS.split(',').map(value => value.trim()).filter(Boolean);
  }
  for (const [key, variable] of [
    ['timeoutMs', 'FRIGATE_TIMEOUT_MS'],
    ['maxResponseBytes', 'FRIGATE_MAX_RESPONSE_BYTES'],
    ['maxConcurrent', 'FRIGATE_MAX_CONCURRENT'],
    ['eventsPageSize', 'FRIGATE_EVENTS_PAGE_SIZE'],
    ['eventsMaxWindowSeconds', 'FRIGATE_EVENTS_MAX_WINDOW_SECONDS'],
    ['maxResultBytes', 'FRIGATE_MAX_RESULT_BYTES'],
  ] as const) {
    if (env[variable] !== undefined) options[key] = Number(env[variable]);
  }
  return options;
}
