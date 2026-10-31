import { validateOptions, type FrigateOptions } from './config.js';
import { Session, SessionError, type SessionMode } from './auth.js';
import { performRequest, TransportError } from './http.js';
import {
  compatibility,
  capabilitiesOutputSchema,
  getEventOutputSchema,
  listCamerasOutputSchema,
  listEventsOutputSchema,
  searchEventsOutputSchema,
  outputSchema,
  statisticsSchema,
  type CapabilitiesResult,
  type EventSummary,
  type GetEventResult,
  type ListEventsInput,
  type ListCamerasResult,
  type ListEventsResult,
  type ReadError,
  type SearchEventsInput,
  type SearchEventsResult,
  type Statistics,
  type StatusResult,
} from './contract.js';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ReadError };
type SearchCapability = 'supported' | 'disabled' | 'unsupported' | 'unknown';
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

  /** Translate one upstream event into the sanitized, allowlisted shape. */
  #sanitizeEvent(raw: unknown): { ok: true; value: EventSummary } | { ok: false; error: ReadError } {
    if (!raw || typeof raw !== 'object') return { ok: false, error: problem('malformed_response', 'Unexpected Frigate event response') };
    const event = raw as Record<string, unknown>;
    const id = typeof event.id === 'string' ? event.id : undefined;
    const camera = typeof event.camera === 'string' ? event.camera : undefined;
    const label = typeof event.label === 'string' ? event.label : undefined;
    const startTime = typeof event.start_time === 'number' && Number.isFinite(event.start_time) ? event.start_time : undefined;
    if (!id || id.length > 64 || !camera || camera.length > 64 || !label || label.length > 64 || startTime === undefined) {
      return { ok: false, error: problem('malformed_response', 'Unexpected Frigate event response') };
    }
    const zones = Array.isArray(event.zones)
      ? event.zones.filter(zone => typeof zone === 'string' && zone.length <= 64).slice(0, 64)
      : [];
    const endTime = typeof event.end_time === 'number' && Number.isFinite(event.end_time) ? event.end_time : undefined;
    const subLabel = typeof event.sub_label === 'string' && event.sub_label.length > 0 && event.sub_label.length <= 64 ? event.sub_label : undefined;
    const data = event.data && typeof event.data === 'object' ? event.data as Record<string, unknown> : undefined;
    const score = data && typeof data.score === 'number' && Number.isFinite(data.score) && data.score >= 0 && data.score <= 1
      ? data.score : undefined;
    const speed = data && typeof data.average_estimated_speed === 'number' && Number.isFinite(data.average_estimated_speed) && data.average_estimated_speed >= 0
      ? data.average_estimated_speed : undefined;
    const searchDistance = typeof event.search_distance === 'number' && Number.isFinite(event.search_distance) ? event.search_distance : undefined;
    const searchSource = event.search_source === 'thumbnail' || event.search_source === 'description' ? event.search_source : undefined;
    return {
      ok: true,
      value: {
        id,
        camera,
        label,
        ...(subLabel === undefined ? {} : { subLabel }),
        zones,
        startTime,
        ...(endTime === undefined ? {} : { endTime }),
        hasClip: event.has_clip === true,
        hasSnapshot: event.has_snapshot === true,
        ...(score === undefined ? {} : { score }),
        ...(speed === undefined ? {} : { speed }),
        ...(searchDistance === undefined ? {} : { searchDistance }),
        ...(searchSource === undefined ? {} : { searchSource }),
      },
    };
  }

  async listEvents(input: ListEventsInput, cancellation?: AbortSignal): Promise<ListEventsResult> {
    const deadline = AbortSignal.timeout(this.#options.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    const ordering = input.sort ?? 'date_desc';
    const limit = Math.min(input.limit ?? this.#options.eventsPageSize, this.#options.eventsPageSize, 200);
    const offset = input.offset ?? 0;
    const interval = { after: input.after, before: input.before, maxWindowSeconds: this.#options.eventsMaxWindowSeconds };
    const page = { limit, offset, returned: 0, ordering };
    const empty = { events: [], page, interval, completeness: { complete: true, truncated: false } };
    const failure = (error: ReadError, warnings: string[] = []) =>
      listEventsOutputSchema.parse({ ok: false, error, data: empty, meta: this.#metadata(warnings) });

    // Time handling: UTC Unix seconds, never milliseconds.
    if (Math.abs(input.after) > 1e11 || Math.abs(input.before) > 1e11) {
      return failure(problem('invalid_request', 'Timestamps must be UTC Unix seconds, not milliseconds'), ['Timestamps are interpreted as UTC Unix seconds']);
    }
    if (!(input.before > input.after)) {
      return failure(problem('invalid_request', 'Interval start must be earlier than its end'));
    }
    if (input.before - input.after > this.#options.eventsMaxWindowSeconds) {
      return failure(problem('invalid_request', `Interval exceeds the configured ${this.#options.eventsMaxWindowSeconds} second maximum window`));
    }
    if (input.minScore !== undefined && input.maxScore !== undefined && input.minScore > input.maxScore) {
      return failure(problem('invalid_request', 'Minimum score must not exceed the maximum score'));
    }
    // Camera scope: an explicitly forbidden camera is rejected, never broadened.
    const allowed = this.#options.cameraScopeRestricted ? new Set(this.#options.cameras) : undefined;
    if (allowed && input.cameras?.some(camera => !allowed.has(camera))) {
      return failure(problem('forbidden', 'One or more cameras are outside the configured scope'));
    }
    const requestedCameras = input.cameras?.length ? input.cameras : allowed ? [...allowed] : undefined;

    const query = new URLSearchParams();
    query.set('after', String(input.after));
    query.set('before', String(input.before));
    query.set('limit', String(limit));
    query.set('offset', String(offset));
    query.set('include_thumbnails', '0');
    query.set('sort', ordering);
    if (requestedCameras?.length) query.set('cameras', requestedCameras.join(','));
    if (input.labels?.length) query.set('labels', input.labels.join(','));
    if (input.subLabels?.length) query.set('sub_labels', input.subLabels.join(','));
    if (input.zones?.length) query.set('zones', input.zones.join(','));
    if (input.hasClip !== undefined) query.set('has_clip', input.hasClip ? '1' : '0');
    if (input.hasSnapshot !== undefined) query.set('has_snapshot', input.hasSnapshot ? '1' : '0');
    if (input.inProgress !== undefined) query.set('in_progress', input.inProgress ? '1' : '0');
    if (input.minScore !== undefined) query.set('min_score', String(input.minScore));
    if (input.maxScore !== undefined) query.set('max_score', String(input.maxScore));

    const admitted = this.#admit();
    try {
      const raw = await this.#request(`events?${query.toString()}`, 'application/json', signal);
      if (!raw.ok) return failure(raw.error);
      if (raw.value.status !== 200) return failure(this.#statusError(raw.value.status));
      if (!this.#hasMime(raw.value, 'application/json')) return failure(problem('malformed_response', 'Unexpected Frigate content type'));
      let parsed: unknown;
      try { parsed = JSON.parse(raw.value.body.toString('utf8')); }
      catch { return failure(problem('malformed_response', 'Unexpected Frigate events response')); }
      if (!Array.isArray(parsed)) return failure(problem('malformed_response', 'Unexpected Frigate events response'));
      const events: EventSummary[] = [];
      const seen = new Set<string>();
      for (const entry of parsed) {
        const sanitized = this.#sanitizeEvent(entry);
        if (!sanitized.ok) return failure(sanitized.error);
        if (allowed && !allowed.has(sanitized.value.camera)) continue;
        if (seen.has(sanitized.value.id)) continue;
        seen.add(sanitized.value.id);
        events.push(sanitized.value);
        if (events.length > 200) return failure(problem('payload_too_large', 'Frigate returned more events than the server can bound'));
      }
      const truncated = events.length >= limit;
      const data = {
        events,
        page: { limit, offset, returned: events.length, ...(truncated ? { nextOffset: offset + events.length } : {}), ordering },
        interval,
        completeness: { complete: !truncated, truncated },
      };
      const serialized = JSON.stringify(data).length;
      if (serialized > this.#options.maxResultBytes) {
        return failure(problem('payload_too_large', 'The event result exceeds the configured result size limit'));
      }
      const warnings: string[] = [];
      if (truncated) warnings.push('The page limit was reached; more events may exist in this interval');
      if (offset > 0) warnings.push('Paging over a live dataset can shift or duplicate events between pages');
      return listEventsOutputSchema.parse({ ok: true, data, meta: this.#metadata(warnings) });
    } finally {
      if (admitted) this.#release();
    }
  }

  async getEvent(eventId: string, cancellation?: AbortSignal): Promise<GetEventResult> {
    const deadline = AbortSignal.timeout(this.#options.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    const failure = (error: ReadError) =>
      getEventOutputSchema.parse({ ok: false, error, data: {}, meta: this.#metadata([]) });
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(eventId) || eventId.includes('..')) {
      return failure(problem('invalid_request', 'Invalid event identifier'));
    }
    const admitted = this.#admit();
    try {
      const raw = await this.#request(`events/${encodeURIComponent(eventId)}`, 'application/json', signal);
      if (!raw.ok) return failure(raw.error);
      if (raw.value.status === 404) return failure(problem('not_found', 'Frigate event not found', false, 404));
      if (raw.value.status !== 200) return failure(this.#statusError(raw.value.status));
      if (!this.#hasMime(raw.value, 'application/json')) return failure(problem('malformed_response', 'Unexpected Frigate content type'));
      let parsed: unknown;
      try { parsed = JSON.parse(raw.value.body.toString('utf8')); }
      catch { return failure(problem('malformed_response', 'Unexpected Frigate event response')); }
      const sanitized = this.#sanitizeEvent(parsed);
      if (!sanitized.ok) return failure(sanitized.error);
      if (this.#options.cameraScopeRestricted && !this.#options.cameras.includes(sanitized.value.camera)) {
        // Do not reveal metadata about an event outside the configured scope.
        return failure(problem('forbidden', 'The event is outside the configured camera scope'));
      }
      return getEventOutputSchema.parse({ ok: true, data: { event: sanitized.value }, meta: this.#metadata([]) });
    } finally {
      if (admitted) this.#release();
    }
  }

  /**
   * Semantic search over the upstream search service.
   *
   * The search is billable upstream, so it is only performed when the caller
   * explicitly asks for it. Capability states are observed, never guessed: a
   * successful search reports `supported`, a disabled service reports
   * `disabled`, a missing endpoint reports `unsupported`, and anything else
   * stays `unknown`.
   */
  async searchEvents(input: SearchEventsInput, cancellation?: AbortSignal): Promise<SearchEventsResult> {
    const deadline = AbortSignal.timeout(this.#options.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    const limit = Math.min(input.limit ?? this.#options.eventsPageSize, this.#options.eventsPageSize, 200);
    const offset = input.offset ?? 0;
    const interval = { after: input.after, before: input.before, maxWindowSeconds: this.#options.eventsMaxWindowSeconds };
    const page = { limit, offset, returned: 0, ordering: 'relevance' as const };
    const empty = { events: [], page, interval, completeness: { complete: true, truncated: false } };
    const failure = (error: ReadError, capability: SearchCapability, warnings: string[] = []) =>
      searchEventsOutputSchema.parse({ ok: false, error, data: { ...empty, capability }, meta: this.#metadata(warnings) });

    if (Math.abs(input.after) > 1e11 || Math.abs(input.before) > 1e11) {
      return failure(problem('invalid_request', 'Timestamps must be UTC Unix seconds, not milliseconds'), 'unknown', ['Timestamps are interpreted as UTC Unix seconds']);
    }
    if (!(input.before > input.after)) {
      return failure(problem('invalid_request', 'Interval start must be earlier than its end'), 'unknown');
    }
    if (input.before - input.after > this.#options.eventsMaxWindowSeconds) {
      return failure(problem('invalid_request', `Interval exceeds the configured ${this.#options.eventsMaxWindowSeconds} second maximum window`), 'unknown');
    }
    const allowed = this.#options.cameraScopeRestricted ? new Set(this.#options.cameras) : undefined;
    if (allowed && input.cameras?.some(camera => !allowed.has(camera))) {
      return failure(problem('forbidden', 'One or more cameras are outside the configured scope'), 'unknown');
    }
    const requestedCameras = input.cameras?.length ? input.cameras : allowed ? [...allowed] : undefined;

    const query = new URLSearchParams();
    query.set('query', input.query);
    query.set('after', String(input.after));
    query.set('before', String(input.before));
    query.set('limit', String(limit));
    query.set('offset', String(offset));
    query.set('include_thumbnails', '0');
    query.set('sort', 'relevance');
    query.set('search_type', input.searchType === 'both' ? 'thumbnail,description' : input.searchType ?? 'thumbnail');
    if (requestedCameras?.length) query.set('cameras', requestedCameras.join(','));
    if (input.labels?.length) query.set('labels', input.labels.join(','));
    if (input.subLabels?.length) query.set('sub_labels', input.subLabels.join(','));
    if (input.zones?.length) query.set('zones', input.zones.join(','));

    const admitted = this.#admit();
    try {
      const raw = await this.#request(`events/search?${query.toString()}`, 'application/json', signal);
      if (!raw.ok) return failure(raw.error, 'unknown');
      if (raw.value.status === 404) {
        return failure(problem('feature_unsupported', 'This Frigate release does not provide semantic search', false, 404), 'unsupported');
      }
      if (raw.value.status === 400 && this.#isSearchDisabled(raw.value.body)) {
        return failure(problem('feature_disabled', 'Semantic search is not enabled on this Frigate instance', false, 400), 'disabled',
          ['Semantic search is disabled; fall back to list_events with ordinary filters']);
      }
      if (raw.value.status !== 200) return failure(this.#statusError(raw.value.status), 'unknown');
      if (!this.#hasMime(raw.value, 'application/json')) return failure(problem('malformed_response', 'Unexpected Frigate content type'), 'unknown');
      let parsed: unknown;
      try { parsed = JSON.parse(raw.value.body.toString('utf8')); }
      catch { return failure(problem('malformed_response', 'Unexpected Frigate search response'), 'unknown'); }
      if (!Array.isArray(parsed)) return failure(problem('malformed_response', 'Unexpected Frigate search response'), 'unknown');
      const events: EventSummary[] = [];
      const seen = new Set<string>();
      for (const entry of parsed) {
        const sanitized = this.#sanitizeEvent(entry);
        if (!sanitized.ok) return failure(sanitized.error, 'unknown');
        if (allowed && !allowed.has(sanitized.value.camera)) continue;
        if (seen.has(sanitized.value.id)) continue;
        seen.add(sanitized.value.id);
        events.push(sanitized.value);
        if (events.length > 200) return failure(problem('payload_too_large', 'Frigate returned more search results than the server can bound'), 'unknown');
      }
      const truncated = events.length >= limit;
      const data = {
        events,
        page: { limit, offset, returned: events.length, ...(truncated ? { nextOffset: offset + events.length } : {}), ordering: 'relevance' as const },
        interval,
        completeness: { complete: !truncated, truncated },
        capability: 'supported' as const,
      };
      if (JSON.stringify(data).length > this.#options.maxResultBytes) {
        return failure(problem('payload_too_large', 'The search result exceeds the configured result size limit'), 'unknown');
      }
      const warnings: string[] = [];
      if (truncated) warnings.push('The page limit was reached; more matches may exist in this interval');
      if (offset > 0) warnings.push('Paging over a live dataset can shift or duplicate events between pages');
      return searchEventsOutputSchema.parse({ ok: true, data, meta: this.#metadata(warnings) });
    } finally {
      if (admitted) this.#release();
    }
  }

  /** Detect the upstream "semantic search is not enabled" answer without echoing it. */
  #isSearchDisabled(body: Buffer): boolean {
    try {
      const parsed = JSON.parse(body.toString('utf8')) as { message?: unknown };
      return parsed?.message === 'Semantic search is not enabled';
    } catch { return false; }
  }
}
