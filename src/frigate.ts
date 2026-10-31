import { validateOptions, type FrigateOptions } from './config.js';
import { compatibility, outputSchema, statisticsSchema, type ReadError, type StatusResult } from './contract.js';

type Outcome<T> = { ok: true; value: T } | { ok: false; error: ReadError };
class ReadFailure extends Error {
  constructor(readonly detail: ReadError) { super(detail.message); }
}
const problem = (code: ReadError['code'], message: string, retryable = false, status?: number): ReadError =>
  ({ code, message, retryable, ...(status === undefined ? {} : { status }) });

export class FrigateClient {
  readonly #options;
  #active = 0;
  constructor(options: FrigateOptions) { this.#options = validateOptions(options); }

  async #read(path: '' | 'version' | 'stats', signal: AbortSignal): Promise<Outcome<string>> {
    try {
      signal.throwIfAborted();
      const headers: Record<string, string> = { Accept: path === 'stats' ? 'application/json' : 'text/plain' };
      if (this.#options.bearerToken) headers.Authorization = `Bearer ${this.#options.bearerToken}`;
      const response = await fetch(new URL(path, this.#options.root), { headers, redirect: 'manual', signal });
      if (!response.ok) {
        await response.body?.cancel();
        const status = response.status;
        const detail = status >= 300 && status < 400 ? problem('redirect_rejected', 'Upstream redirect rejected', false, status)
          : status === 401 ? problem('authentication', 'Frigate authentication required or expired', false, status)
          : status === 403 ? problem('forbidden', 'Frigate denied access', false, status)
          : status === 404 ? problem('not_found', 'Frigate endpoint unavailable', false, status)
          : status === 429 ? problem('rate_limit', 'Frigate rate limit reached', true, status)
          : problem('upstream_error', 'Frigate returned an unsuccessful response', status === 408 || status >= 500, status);
        return { ok: false, error: detail };
      }
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      if (mime !== (path === 'stats' ? 'application/json' : 'text/plain')) {
        await response.body?.cancel();
        return { ok: false, error: problem('malformed_response', 'Unexpected Frigate content type') };
      }
      const reader = response.body?.getReader();
      if (!reader) return { ok: false, error: problem('malformed_response', 'Empty Frigate response') };
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > this.#options.maxResponseBytes) {
            throw new ReadFailure(problem('payload_too_large', 'Frigate response exceeded byte limit'));
          }
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return { ok: true, value: Buffer.concat(chunks).toString('utf8') };
    } catch (error) {
      if (error instanceof ReadFailure) return { ok: false, error: error.detail };
      if (signal.aborted) return { ok: false, error: signal.reason?.name === 'TimeoutError'
        ? problem('timeout', 'Frigate status deadline exceeded', true)
        : problem('cancelled', 'Frigate request cancelled') };
      return { ok: false, error: problem('unreachable', 'Unable to reach Frigate', true) };
    }
  }

  async status(cancellation?: AbortSignal): Promise<StatusResult> {
    const deadline = AbortSignal.timeout(this.#options.timeoutMs);
    const signal = cancellation ? AbortSignal.any([cancellation, deadline]) : deadline;
    const busy = this.#active >= this.#options.maxConcurrent;
    if (!busy) this.#active++;
    try {
      // Sequential component reads share one deadline. At most maxConcurrent requests
      // are in flight across all status calls; excess calls fail without queue growth.
      const read = (path: '' | 'version' | 'stats') => busy
        ? Promise.resolve<Outcome<string>>({ ok: false, error: problem('busy', 'Frigate concurrency limit reached', true) })
        : this.#read(path, signal);
      const rawHealth = await read('');
      const rawVersion = await read('version');
      const rawStats = await read('stats');
      const health = !rawHealth.ok ? rawHealth : rawHealth.value.trim() === 'Frigate is running. Alive and healthy!'
        ? { ok: true as const, alive: true as const }
        : { ok: false as const, error: problem('malformed_response', 'Unexpected Frigate health response') };
      const version = !rawVersion.ok ? rawVersion
        : /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:[-+][a-zA-Z0-9.-]+)?$/.test(rawVersion.value.trim()) && rawVersion.value.trim().length <= 80
          ? { ok: true as const, version: rawVersion.value.trim(), compatibility: compatibility(rawVersion.value.trim()) }
          : { ok: false as const, error: problem('malformed_response', 'Unexpected Frigate version response') };
      let statistics: StatusResult['data']['statistics'];
      if (!rawStats.ok) statistics = rawStats;
      else {
        let parsed;
        try { parsed = statisticsSchema.safeParse(JSON.parse(rawStats.value)); }
        catch { /* Do not expose JSON text or parser diagnostics. */ }
        statistics = parsed?.success ? { ok: true, statistics: parsed.data }
          : { ok: false, error: problem('malformed_response', 'Unexpected Frigate statistics response') };
      }
      const authorizedApiAccess = statistics.ok ? 'confirmed' as const
        : ['authentication', 'forbidden'].includes(statistics.error.code) ? 'denied' as const : 'unknown' as const;
      const data = { health, version, statistics, authorizedApiAccess };
      const warnings: string[] = [];
      if (version.ok && version.compatibility !== 'supported') warnings.push(`Frigate version contract is ${version.compatibility}; only 0.18.2 has been contract-tested`);
      if (!statistics.ok) warnings.push('Public health/version do not establish authorized API access');
      const meta = { observedAt: new Date().toISOString(), warnings, contractRelease: '0.18.2' as const };
      // Prefer protected API failures so public health cannot conceal authentication errors.
      const error = [statistics, health, version].find(component => !component.ok);
      return outputSchema.parse(error && !error.ok ? { ok: false, error: error.error, data, meta } : { ok: true, data, meta });
    } finally {
      if (!busy) this.#active--;
    }
  }
}
