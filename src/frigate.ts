import { validateOptions, type FrigateOptions } from './config.js';
import { Session, SessionError, type SessionMode } from './auth.js';
import { performRequest, TransportError } from './http.js';
import {
  compatibility,
  capabilitiesOutputSchema,
  listCamerasOutputSchema,
  outputSchema,
  statisticsSchema,
  type CapabilitiesResult,
  type ListCamerasResult,
  type ReadError,
  type Statistics,
  type StatusResult,
} from './contract.js';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ReadError };
type RawResponse = { status: number; body: Buffer; headers: Record<string, string | string[] | undefined> };

const problem = (code: ReadError['code'], message: string, retryable = false, status?: number): ReadError =>
  ({ code, message, retryable, ...(status === undefined ? {} : { status }) });

const TRANSIENT_STATUS = new Set([408, 425, 429]);
const MAX_TRANSIENT_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 2_000;

function retryAfterMs(value: string | string[] | undefined): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, seconds * 1000));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, Math.min(MAX_RETRY_AFTER_MS, date - Date.now()));
  return undefined;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(new Error('aborted')); return; }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
  signal.addEventListener('abort', onAbort, { once: true });
});

export class FrigateClient {
  readonly #options;
  readonly #session: Session;
  #active = 0;

  constructor(options: FrigateOptions) {
    this.#options = validateOptions(options);
    this.#session = new Session({
      root: this.#options.root,
      bearerToken: this.#options.bearerToken,
      username: this.#options.username,
      password: this.#options.password,
      cookieName: this.#options.cookieName,
      maxBytes: this.#options.maxResponseBytes,
      ca: this.#options.ca,
    });
  }

  get sessionMode(): SessionMode { return this.#session.mode; }

  /** Request an upstream read, with bounded transient retries and one authentication retry. */
  async #request(path: string, accept: string, signal: AbortSignal): Promise<Outcome<RawResponse>> {
    const url = new URL(path, this.#options.root);
    let transientRetries = 0;
    let authRetried = false;
    while (true) {
      let headers: Record<string, string>;
      try {
        headers = await this.#session.headers(signal);
      } catch (error) {
        return { ok: false, error: this.#sessionError(error) };
      }
      let response: RawResponse;
      try {
        const raw = await performRequest({
          url,
          headers: { accept, ...headers },
          signal,
          maxBytes: this.#options.maxResponseBytes,
          ...(this.#options.ca ? { ca: this.#options.ca } : {}),
        });
        response = { status: raw.status, body: raw.body, headers: raw.headers };
      } catch (error) {
        if (error instanceof TransportError) {
          if (error.kind === 'timeout') return { ok: false, error: problem('timeout', 'Frigate status deadline exceeded', true) };
          if (error.kind === 'cancelled') return { ok: false, error: problem('cancelled', 'Frigate request cancelled') };
          if (error.kind === 'payload_too_large') return { ok: false, error: problem('payload_too_large', 'Frigate response exceeded byte limit') };
          if (transientRetries < MAX_TRANSIENT_RETRIES && !signal.aborted) {
            transientRetries++;
            if (!await this.#wait(this.#backoff(transientRetries), signal)) return { ok: false, error: problem('timeout', 'Frigate status deadline exceeded', true) };
            continue;
          }
          return { ok: false, error: problem('unreachable', 'Unable to reach Frigate', true) };
        }
        return { ok: false, error: problem('unreachable', 'Unable to reach Frigate', true) };
      }
      this.#session.observe(response.headers);
      if (response.status === 401 && this.#session.mode === 'managed' && !authRetried) {
        // At most one authentication retry per read; the session manager
        // serializes the re-login so concurrent reads cannot pile up logins.
        authRetried = true;
        try {
          await this.#session.refresh(signal);
        } catch (error) {
          return { ok: false, error: this.#sessionError(error) };
        }
        continue;
      }
      if ((TRANSIENT_STATUS.has(response.status) || response.status >= 500) && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        const delay = response.status === 429
          ? retryAfterMs(response.headers['retry-after']) ?? this.#backoff(transientRetries)
          : this.#backoff(transientRetries);
        if (!await this.#wait(delay, signal)) return { ok: false, error: problem('timeout', 'Frigate status deadline exceeded', true) };
        continue;
      }
      return { ok: true, value: response };
    }
  }

  #backoff(attempt: number): number {
    return Math.min(750, 100 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 40);
  }

  /** Wait, but never past the caller's deadline. Returns false when the deadline expired. */
  async #wait(ms: number, signal: AbortSignal): Promise<boolean> {
    try { await sleep(ms, signal); return true; }
    catch { return false; }
  }

  #sessionError(error: unknown): ReadError {
    if (error instanceof SessionError) {
      if (error.code === 'authentication') return problem('authentication', error.message, false, error.status);
      if (error.code === 'unreachable') return problem('unreachable', error.message, true, error.status);
      return problem('upstream_error', error.message, true, error.status);
    }
    return problem('unreachable', 'Unable to reach Frigate', true);
  }

  /** Map an upstream HTTP status to a stable error category. */
  #statusError(status: number): ReadError {
    if (status >= 300 && status < 400) return problem('redirect_rejected', 'Upstream redirect rejected', false, status);
    if (status === 401) return problem('authentication', this.#session.mode === 'bearer'
      ? 'Frigate rejected the supplied bearer token; supply a fresh token'
      : 'Frigate authentication required or expired', false, status);
    if (status === 403) return problem('forbidden', 'Frigate denied access', false, status);
    if (status === 404) return problem('not_found', 'Frigate endpoint unavailable', false, status);
    if (status === 429) return problem('rate_limit', 'Frigate rate limit reached', true, status);
    return problem('upstream_error', 'Frigate returned an unsuccessful response', status === 408 || status >= 500, status);
  }

  #metadata(warnings: string[]) {
    return { observedAt: new Date().toISOString(), warnings: warnings.slice(0, 8), contractRelease: '0.18.2' as const };
  }

  /** Acquire one of the bounded concurrent upstream slots. */
  #admit(): boolean {
    if (this.#active >= this.#options.maxConcurrent) return false;
    this.#active++;
    return true;
  }

  #release() { this.#active--; }

  async status(cancellation?: AbortSignal): Promise<StatusResult> {
    const deadline = AbortSignal.timeout(this.#options.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    const admitted = this.#admit();
    try {
      const read = async (path: string, accept: string) => admitted
        ? this.#request(path, accept, signal)
        : Promise.resolve<Outcome<RawResponse>>({ ok: false, error: problem('busy', 'Frigate concurrency limit reached', true) });
      const rawHealth = await read('', 'text/plain');
      const rawVersion = await read('version', 'text/plain');
      const rawStats = await read('stats', 'application/json');
      // An unsuccessful status is reported before the body is inspected.
      const checked = (value: Outcome<RawResponse>): Outcome<RawResponse> =>
        value.ok && value.value.status !== 200 ? { ok: false, error: this.#statusError(value.value.status) } : value;
      const healthRaw = checked(rawHealth);
      const versionRaw = checked(rawVersion);
      const statsRaw = checked(rawStats);
      const health = !healthRaw.ok ? healthRaw
        : !this.#hasMime(healthRaw.value, 'text/plain')
          ? { ok: false as const, error: problem('malformed_response', 'Unexpected Frigate content type') }
          : healthRaw.value.body.toString('utf8').trim() === 'Frigate is running. Alive and healthy!'
            ? { ok: true as const, alive: true as const }
            : { ok: false as const, error: problem('malformed_response', 'Unexpected Frigate health response') };
      const version = !versionRaw.ok ? versionRaw
        : !this.#hasMime(versionRaw.value, 'text/plain')
          ? { ok: false as const, error: problem('malformed_response', 'Unexpected Frigate content type') }
          : this.#parseVersion(versionRaw.value.body.toString('utf8').trim());
      let statistics: StatusResult['data']['statistics'];
      if (!statsRaw.ok) statistics = statsRaw;
      else if (!this.#hasMime(statsRaw.value, 'application/json')) {
        statistics = { ok: false, error: problem('malformed_response', 'Unexpected Frigate content type') };
      } else {
        let parsed;
        try { parsed = statisticsSchema.safeParse(JSON.parse(statsRaw.value.body.toString('utf8'))); }
        catch { /* Do not expose JSON text or parser diagnostics. */ }
        statistics = parsed?.success
          ? { ok: true, statistics: this.#scopeStatistics(parsed.data) }
          : { ok: false, error: problem('malformed_response', 'Unexpected Frigate statistics response') };
      }
      const authorizedApiAccess = statistics.ok ? 'confirmed' as const
        : ['authentication', 'forbidden'].includes(statistics.error.code) ? 'denied' as const : 'unknown' as const;
      const data = { health, version, statistics, authorizedApiAccess };
      const warnings: string[] = [];
      if (version.ok && version.compatibility !== 'supported') warnings.push(`Frigate version contract is ${version.compatibility}; only 0.18.2 has been contract-tested`);
      if (!statistics.ok) warnings.push('Public health/version do not establish authorized API access');
      if (this.#options.cameraScopeRestricted) warnings.push('Camera scope is restricted; unscopable aggregates are omitted');
      const meta = this.#metadata(warnings);
      // Prefer protected API failures so public health cannot conceal authentication errors.
      const error = [statistics, health, version].find(component => !component.ok);
      return outputSchema.parse(error && !error.ok ? { ok: false, error: error.error, data, meta } : { ok: true, data, meta });
    } finally {
      if (admitted) this.#release();
    }
  }

  /** Drop cameras outside the operator scope and unscopable global aggregates. */
  #scopeStatistics(statistics: Statistics): Statistics {
    if (!this.#options.cameraScopeRestricted) return statistics;
    const allowed = new Set(this.#options.cameras);
    const cameras: Statistics['cameras'] = {};
    for (const [camera, value] of Object.entries(statistics.cameras)) {
      if (allowed.has(camera)) cameras[camera] = value;
    }
    // Detector inference speed is a global aggregate and cannot be scoped to a
    // camera subset, so it is omitted instead of leaking a forbidden scope.
    return { cameras, detectors: {}, service: statistics.service };
  }

  #hasMime(response: RawResponse, expected: string): boolean {
    const raw = response.headers['content-type'];
    const mime = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0]?.trim().toLowerCase();
    return mime === expected;
  }

  #parseVersion(text: string): StatusResult['data']['version'] {
    if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(text) || text.length > 80) {
      return { ok: false, error: problem('malformed_response', 'Unexpected Frigate version response') };
    }
    return { ok: true, version: text, compatibility: compatibility(text) };
  }

  /** Read the allowlisted configuration fields used for discovery. */
  async #readConfig(signal: AbortSignal): Promise<Outcome<{ cameras: { id: string; zones: string[]; detectionEnabled?: boolean }[]; labels: string[] }>> {
    const raw = await this.#request('config', 'application/json', signal);
    if (!raw.ok) return raw;
    if (raw.value.status !== 200) return { ok: false, error: this.#statusError(raw.value.status) };
    let parsed: unknown;
    try { parsed = JSON.parse(raw.value.body.toString('utf8')); }
    catch { return { ok: false, error: problem('malformed_response', 'Unexpected Frigate configuration response') }; }
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: problem('malformed_response', 'Unexpected Frigate configuration response') };
    const config = parsed as { cameras?: unknown; tracked_objects?: unknown };
    const cameras: { id: string; zones: string[]; detectionEnabled?: boolean }[] = [];
    if (config.cameras && typeof config.cameras === 'object' && !Array.isArray(config.cameras)) {
      for (const [id, value] of Object.entries(config.cameras as Record<string, unknown>)) {
        if (cameras.length >= 128) break;
        const camera = (value && typeof value === 'object' ? value : {}) as { zones?: unknown; detect?: { enabled?: unknown } };
        const zones: string[] = [];
        if (camera.zones && typeof camera.zones === 'object' && !Array.isArray(camera.zones)) {
          for (const zoneName of Object.keys(camera.zones as Record<string, unknown>)) {
            if (zones.length >= 64) break;
            if (zoneName.length <= 64) zones.push(zoneName);
          }
        }
        const detectionEnabled = typeof camera.detect?.enabled === 'boolean' ? camera.detect.enabled : undefined;
        cameras.push({ id: id.slice(0, 64), zones, ...(detectionEnabled === undefined ? {} : { detectionEnabled }) });
      }
    }
    const labels: string[] = [];
    if (Array.isArray(config.tracked_objects)) {
      for (const entry of config.tracked_objects) {
        if (labels.length >= 256) break;
        const label = (entry && typeof entry === 'object' ? (entry as { label?: unknown }).label : undefined);
        if (typeof label === 'string' && label.length > 0 && label.length <= 64) labels.push(label);
      }
    }
    return { ok: true, value: { cameras, labels } };
  }

  async listCameras(input: { camera?: string | undefined }, cancellation?: AbortSignal): Promise<ListCamerasResult> {
    const deadline = AbortSignal.timeout(this.#options.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    if (input.camera !== undefined && this.#options.cameraScopeRestricted && !this.#options.cameras.includes(input.camera)) {
      // Reject explicitly forbidden cameras instead of silently broadening them.
      const error = problem('forbidden', 'Camera is outside the configured scope', false);
      return listCamerasOutputSchema.parse({ ok: false, error, data: { scope: 'restricted', cameras: [] }, meta: this.#metadata(['Camera scope is restricted; unscopable aggregates are omitted']) });
    }
    const admitted = this.#admit();
    try {
      const config = await this.#readConfig(signal);
      if (!config.ok) {
        const data = { scope: this.#options.cameraScopeRestricted ? 'restricted' as const : 'unrestricted' as const, cameras: [] };
        return listCamerasOutputSchema.parse({ ok: false, error: config.error, data, meta: this.#metadata([]) });
      }
      const allowed = this.#options.cameraScopeRestricted ? new Set(this.#options.cameras) : undefined;
      let cameras = config.value.cameras;
      if (allowed) cameras = cameras.filter(camera => allowed.has(camera.id));
      if (input.camera !== undefined) cameras = cameras.filter(camera => camera.id === input.camera);
      const data = { scope: allowed ? 'restricted' as const : 'unrestricted' as const, cameras };
      return listCamerasOutputSchema.parse({ ok: true, data, meta: this.#metadata([]) });
    } finally {
      if (admitted) this.#release();
    }
  }

  async capabilities(cancellation?: AbortSignal): Promise<CapabilitiesResult> {
    const deadline = AbortSignal.timeout(this.#options.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    const admitted = this.#admit();
    try {
      // Reads stay sequential so one tool call never exceeds the upstream
      // concurrency bound.
      const versionRaw = await this.#request('version', 'text/plain', signal);
      const config = await this.#readConfig(signal);
      const versionText = versionRaw.ok && versionRaw.value.status === 200 && this.#hasMime(versionRaw.value, 'text/plain')
        ? versionRaw.value.body.toString('utf8').trim() : undefined;
      const version = versionText && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(versionText) && versionText.length <= 80
        ? { version: versionText, compatibility: compatibility(versionText) } : undefined;
      if (!config.ok) {
        const data = {
          ...(version ? { version } : {}),
          capabilities: { objectEvents: 'unknown' as const, semanticSearch: 'unknown' as const, reviews: 'unknown' as const, recordingAvailability: 'unknown' as const, imageSnapshots: 'unknown' as const },
          trackedLabels: [],
          policy: this.#policy(0),
        };
        return capabilitiesOutputSchema.parse({ ok: false, error: config.error, data, meta: this.#metadata([]) });
      }
      const contractTested = version?.compatibility === 'supported';
      const capabilities = {
        objectEvents: contractTested ? 'supported' as const : 'unknown' as const,
        semanticSearch: 'unknown' as const,
        reviews: contractTested ? 'supported' as const : 'unknown' as const,
        recordingAvailability: contractTested ? 'supported' as const : 'unknown' as const,
        imageSnapshots: 'unknown' as const,
      };
      const warnings: string[] = [];
      if (version && version.compatibility !== 'supported') warnings.push(`Frigate version contract is ${version.compatibility}; only 0.18.2 has been contract-tested`);
      if (this.#options.cameraScopeRestricted) warnings.push('Camera scope is restricted; unscopable aggregates are omitted');
      if (capabilities.semanticSearch === 'unknown') warnings.push('Semantic search support cannot be determined without a billed search');
      const data = {
        ...(version ? { version } : {}),
        capabilities,
        trackedLabels: [...new Set(config.value.labels)].sort(),
        policy: this.#policy(this.#options.cameraScopeRestricted ? this.#options.cameras.length : config.value.cameras.length),
      };
      return capabilitiesOutputSchema.parse({ ok: true, data, meta: this.#metadata(warnings) });
    } finally {
      if (admitted) this.#release();
    }
  }

  #policy(permittedCameraCount: number) {
    return {
      cameraScope: this.#options.cameraScopeRestricted ? 'restricted' as const : 'unrestricted' as const,
      permittedCameraCount,
      timeoutMs: this.#options.timeoutMs,
      maxResponseBytes: this.#options.maxResponseBytes,
      maxConcurrent: this.#options.maxConcurrent,
    };
  }
}
