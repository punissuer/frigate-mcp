import { performRequest, TransportError } from './http.js';

export type SessionMode = 'none' | 'bearer' | 'managed';

export interface SessionOptions {
  root: URL;
  bearerToken?: string | undefined;
  username?: string | undefined;
  password?: string | undefined;
  /** Frigate's configured JWT cookie name (`auth.cookie_name`, default `frigate_token`). */
  cookieName: string;
  maxBytes: number;
  /** Operator-supplied CA bundle for a private TLS deployment. */
  ca?: Buffer | undefined;
  /** Renew the managed session this many seconds before the JWT expires. */
  refreshWindowSeconds?: number | undefined;
}

export class SessionError extends Error {
  constructor(readonly code: 'authentication' | 'unreachable' | 'upstream_error' | 'malformed_response', message: string, readonly status?: number) {
    super(message);
  }
}

function decodeJwtExpiry(token: string): number | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined;
  } catch { return undefined; }
}

function cookieValue(setCookie: string[] | string | undefined, name: string): string | undefined {
  const entries = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const entry of entries) {
    const [pair] = entry.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (!pair || index <= 0) continue;
    if (pair.slice(0, index).trim() === name) return pair.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * Manages the upstream Frigate session.
 *
 * External bearer tokens are forwarded verbatim and are never refreshed: an
 * expired external token is an actionable operator error, not a retry loop.
 * Managed username/password sessions are refreshed serially, and a rejected
 * credential is remembered so that bad credentials cannot cause a login loop.
 */
export class Session {
  readonly mode: SessionMode;
  #options: SessionOptions;
  #token: string | undefined;
  #expiresAt = 0;
  #login: Promise<string> | undefined;
  #credentialsRejected = false;
  #authenticationDisabled = false;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.mode = options.username ? 'managed' : options.bearerToken ? 'bearer' : 'none';
  }

  get authenticationDisabled() { return this.#authenticationDisabled; }
  get credentialsRejected() { return this.#credentialsRejected; }

  /** Headers for an upstream read. Managed sessions log in on demand. */
  async headers(signal: AbortSignal): Promise<Record<string, string>> {
    if (this.mode === 'bearer') return { authorization: `Bearer ${this.#options.bearerToken}` };
    if (this.mode !== 'managed' || this.#authenticationDisabled) return {};
    if (!this.#token || this.#expiresAt - Date.now() / 1000 <= (this.#options.refreshWindowSeconds ?? 300)) {
      try { await this.login(signal); }
      catch (error) {
        // A Frigate instance with authentication disabled needs no session.
        if (this.#authenticationDisabled) return {};
        throw error;
      }
    }
    return this.#cookieHeaders();
  }

  #cookieHeaders(): Record<string, string> {
    if (!this.#token) return {};
    // The cookie is Frigate's documented session transport; the bearer form is
    // also sent so a deployment that only forwards Authorization still works.
    return { cookie: `${this.#options.cookieName}=${this.#token}`, authorization: `Bearer ${this.#token}` };
  }

  /** Adopt a rotated session cookie issued by Frigate during a read. */
  observe(headers: Record<string, string | string[] | undefined>): void {
    if (this.mode !== 'managed') return;
    const value = cookieValue(headers['set-cookie'], this.#options.cookieName);
    if (!value) return;
    const expiry = decodeJwtExpiry(value);
    if (expiry !== undefined && expiry * 1000 <= Date.now()) return;
    this.#token = value;
    this.#expiresAt = expiry ?? 0;
  }

  /** Discard the current session so the next read authenticates again. */
  invalidate(): void {
    if (this.mode === 'managed') this.#token = undefined;
  }

  /**
   * Serialize session renewal. Concurrent callers share one login attempt, so a
   * burst of reads cannot turn into a burst of upstream logins.
   */
  async refresh(signal: AbortSignal): Promise<void> {
    if (this.mode !== 'managed') throw new SessionError('authentication', 'The supplied bearer token cannot be refreshed');
    if (this.#credentialsRejected) throw new SessionError('authentication', 'Frigate rejected the configured credentials');
    this.#token = undefined;
    if (this.#authenticationDisabled) return;
    await this.login(signal);
  }

  /** Perform (or join) a single login attempt. */
  async login(signal: AbortSignal): Promise<string> {
    if (this.mode !== 'managed') throw new SessionError('authentication', 'No managed Frigate session is configured');
    if (this.#credentialsRejected) throw new SessionError('authentication', 'Frigate rejected the configured credentials');
    if (this.#login) return this.#login;
    const attempt = this.#performLogin(signal).finally(() => { this.#login = undefined; });
    this.#login = attempt;
    return attempt;
  }

  async #performLogin(signal: AbortSignal): Promise<string> {
    const body = Buffer.from(JSON.stringify({ user: this.#options.username, password: this.#options.password }));
    let response;
    try {
      response = await performRequest({
        url: new URL('login', this.#options.root),
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body,
        signal,
        maxBytes: this.#options.maxBytes,
        ...(this.#options.ca ? { ca: this.#options.ca } : {}),
      });
    } catch (error) {
      if (error instanceof TransportError) {
        throw new SessionError(error.kind === 'timeout' ? 'upstream_error' : 'unreachable', 'Unable to reach Frigate to sign in');
      }
      throw error;
    }
    if (response.status === 404) {
      // Frigate answers /login with 404 when authentication is disabled.
      this.#authenticationDisabled = true;
      throw new SessionError('authentication', 'Frigate authentication is disabled on this instance');
    }
    if (response.status === 401 || response.status === 403) {
      this.#credentialsRejected = true;
      throw new SessionError('authentication', 'Frigate rejected the configured credentials', response.status);
    }
    if (response.status !== 200) throw new SessionError('upstream_error', 'Frigate sign-in did not succeed', response.status);
    const token = cookieValue(response.headers['set-cookie'], this.#options.cookieName);
    if (!token) throw new SessionError('malformed_response', 'Frigate sign-in did not return the configured session cookie');
    const expiry = decodeJwtExpiry(token);
    this.#token = token;
    this.#expiresAt = expiry ?? 0;
    return token;
  }
}
