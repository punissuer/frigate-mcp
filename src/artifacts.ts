import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type ArtifactKind = 'event_clip' | 'recording_clip';

export interface ArtifactEvidence {
  kind: ArtifactKind;
  camera: string;
  eventId?: string;
  start?: number;
  end?: number;
}

export interface ArtifactRecord {
  /** Opaque, unguessable identifier. */
  id: string;
  /** Opaque resource URI handed to the host. */
  uri: string;
  mimeType: string;
  byteLength: number;
  createdAt: string;
  expiresAt: string;
  evidence: ArtifactEvidence;
}

export type ArtifactFailure =
  | { kind: 'not_found' }
  | { kind: 'expired' }
  | { kind: 'forbidden' }
  | { kind: 'quota' };

export class ArtifactError extends Error {
  constructor(readonly failure: ArtifactFailure, message: string) { super(message); }
}

export interface ArtifactStoreOptions {
  directory: string;
  quotaBytes: number;
  ttlSeconds: number;
  /** Injectable clock, so expiry can be tested without waiting. */
  now?: () => number;
}

const ID_PATTERN = /^[a-f0-9]{32}$/;
/** A temporary download older than this is considered abandoned. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

/**
 * A private, quota-bounded, expiring artifact store.
 *
 * Artifacts are published atomically: bytes are written to a temporary file
 * first and only then renamed into place, so a partial download is never
 * readable as an artifact. Metadata lives beside the bytes so a restarted
 * server can still serve an artifact that has not expired.
 */
export class ArtifactStore {
  readonly #options: ArtifactStoreOptions;
  readonly #now: () => number;

  constructor(options: ArtifactStoreOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get directory() { return this.#options.directory; }

  async init(): Promise<void> {
    await mkdir(this.#options.directory, { recursive: true, mode: 0o700 });
    await chmod(this.#options.directory, 0o700).catch(() => undefined);
  }

  /** Remove expired artifacts and stale temporary files. */
  async cleanup(): Promise<void> {
    const now = this.#now();
    let entries: string[];
    try { entries = await readdir(this.#options.directory); }
    catch { return; }
    for (const entry of entries) {
      if (entry.endsWith('.tmp')) {
        // Only stale temporaries are removed; a download in flight is not.
        const info = await stat(join(this.#options.directory, entry)).catch(() => undefined);
        if (!info || now - info.mtimeMs > STALE_TEMPORARY_MS) {
          await rm(join(this.#options.directory, entry), { force: true }).catch(() => undefined);
        }
        continue;
      }
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (!ID_PATTERN.test(id)) continue;
      const record = await this.#readRecord(id);
      if (!record || Date.parse(record.expiresAt) <= now) {
        await rm(join(this.#options.directory, id), { force: true }).catch(() => undefined);
        await rm(join(this.#options.directory, entry), { force: true }).catch(() => undefined);
      }
    }
  }

  /** Total bytes held by published artifacts. */
  async usedBytes(): Promise<number> {
    let total = 0;
    let entries: string[];
    try { entries = await readdir(this.#options.directory); }
    catch { return 0; }
    for (const entry of entries) {
      if (!ID_PATTERN.test(entry)) continue;
      try { total += (await stat(join(this.#options.directory, entry))).size; }
      catch { /* The artifact was removed concurrently. */ }
    }
    return total;
  }

  /** Publish a completed temporary file as an artifact. */
  async publish(temporaryPath: string, input: { mimeType: string; evidence: ArtifactEvidence }): Promise<ArtifactRecord> {
    await this.cleanup();
    const info = await stat(temporaryPath).catch(() => undefined);
    if (!info) throw new ArtifactError({ kind: 'not_found' }, 'The artifact was not published');
    if (info.size > this.#options.quotaBytes) {
      throw new ArtifactError({ kind: 'quota' }, 'The artifact exceeds the configured storage quota');
    }
    const used = await this.usedBytes();
    if (used + info.size > this.#options.quotaBytes) {
      throw new ArtifactError({ kind: 'quota' }, 'The artifact store quota is exhausted');
    }
    const id = randomBytes(16).toString('hex');
    const created = this.#now();
    const record: ArtifactRecord = {
      id,
      uri: `frigate://artifact/${id}`,
      mimeType: input.mimeType,
      byteLength: info.size,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.#options.ttlSeconds * 1000).toISOString(),
      evidence: input.evidence,
    };
    const target = join(this.#options.directory, id);
    await rename(temporaryPath, target);
    await chmod(target, 0o600).catch(() => undefined);
    await writeFile(join(this.#options.directory, `${id}.json`), JSON.stringify(record), { mode: 0o600 });
    return record;
  }

  /** Read an artifact's metadata and bytes path, applying expiry and scope. */
  async read(id: string, options: { permittedCameras?: string[] } = {}): Promise<{ record: ArtifactRecord; path: string }> {
    if (!ID_PATTERN.test(id)) throw new ArtifactError({ kind: 'not_found' }, 'Unknown artifact');
    const record = await this.#readRecord(id);
    if (!record) throw new ArtifactError({ kind: 'not_found' }, 'Unknown artifact');
    if (Date.parse(record.expiresAt) <= this.#now()) {
      throw new ArtifactError({ kind: 'expired' }, 'The artifact has expired');
    }
    if (options.permittedCameras && !options.permittedCameras.includes(record.evidence.camera)) {
      throw new ArtifactError({ kind: 'forbidden' }, 'The artifact is outside the configured camera scope');
    }
    const path = join(this.#options.directory, id);
    try { await stat(path); }
    catch { throw new ArtifactError({ kind: 'not_found' }, 'Unknown artifact'); }
    return { record, path };
  }

  async readBytes(id: string, options: { permittedCameras?: string[] } = {}): Promise<{ record: ArtifactRecord; bytes: Buffer }> {
    const { record, path } = await this.read(id, options);
    const bytes = await readFile(path);
    return { record, bytes };
  }

  async #readRecord(id: string): Promise<ArtifactRecord | undefined> {
    try {
      const raw = await readFile(join(this.#options.directory, `${id}.json`), 'utf8');
      const parsed = JSON.parse(raw) as ArtifactRecord;
      if (typeof parsed?.id !== 'string' || parsed.id !== id) return undefined;
      return parsed;
    } catch { return undefined; }
  }
}

/** A stable fingerprint for an artifact request, used only for diagnostics. */
export function artifactFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}
