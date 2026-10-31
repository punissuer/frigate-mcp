export interface FrigateOptions {
  /** Exact API root, including any reverse-proxy prefix and /api. */
  apiRoot: string;
  bearerToken?: string;
  /** Explicitly permit HTTP on a trusted private network (including the fixture). */
  allowInsecureHttp?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxConcurrent?: number;
}

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
  url.pathname = url.pathname.replace(/\/+$/, '') + '/';
  const limits = {
    timeoutMs: options.timeoutMs ?? 15_000,
    maxResponseBytes: options.maxResponseBytes ?? 5 * 1024 * 1024,
    maxConcurrent: options.maxConcurrent ?? 4,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > ({ timeoutMs: 60_000, maxResponseBytes: 5 * 1024 * 1024, maxConcurrent: 32 }[key] ?? 0)) {
      throw new Error(`Invalid ${key} policy limit`);
    }
  }
  return { ...limits, root: url, bearerToken: options.bearerToken };
}

export function optionsFromEnv(env: NodeJS.ProcessEnv): FrigateOptions {
  if (!env.FRIGATE_API_ROOT) throw new Error('FRIGATE_API_ROOT is required (include /api)');
  const options: FrigateOptions = {
    apiRoot: env.FRIGATE_API_ROOT,
    allowInsecureHttp: env.FRIGATE_ALLOW_INSECURE_HTTP === 'true',
  };
  if (env.FRIGATE_BEARER_TOKEN !== undefined) options.bearerToken = env.FRIGATE_BEARER_TOKEN;
  for (const [key, variable] of [
    ['timeoutMs', 'FRIGATE_TIMEOUT_MS'],
    ['maxResponseBytes', 'FRIGATE_MAX_RESPONSE_BYTES'],
    ['maxConcurrent', 'FRIGATE_MAX_CONCURRENT'],
  ] as const) {
    if (env[variable] !== undefined) options[key] = Number(env[variable]);
  }
  return options;
}
