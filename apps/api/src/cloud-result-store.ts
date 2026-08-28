import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  linkSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const ROOT_MODE = 0o700;
const FILE_MODE = 0o600;

export const CLOUD_RESULT_DIRECTORY = 'cloud-results';

export class CloudResultStoreFailure extends Error {
  readonly code = 'cloud_result_storage_failure' as const;

  constructor() {
    super('cloud_result_storage_failure');
    this.name = 'CloudResultStoreFailure';
  }
}

export type CloudResultArtifactKind = 'partial' | 'complete';

export interface CloudResultArtifact {
  readonly requestId: string;
  readonly kind: CloudResultArtifactKind;
  readonly size: number | null;
  readonly modifiedAtMs: number;
  readonly regular: boolean;
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function safeRequestId(requestId: string): boolean {
  return requestId.length > 0 && requestId.length <= 128 && REQUEST_ID_PATTERN.test(requestId);
}

function artifactName(requestId: string, kind: CloudResultArtifactKind): string {
  return `${requestId}.${kind === 'partial' ? 'partial' : 'json'}`;
}

function statsFor(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Owns the only server-side path where encrypted result bytes may exist. The store never accepts
 * a caller path or filename, and never parses the bytes it persists.
 */
export class CloudResultStore {
  readonly root: string;

  constructor(runtimePath: string) {
    if (!isAbsolute(runtimePath) || runtimePath === '/') throw new CloudResultStoreFailure();
    mkdirSync(runtimePath, { recursive: true, mode: ROOT_MODE });
    const runtimeStat = lstatSync(runtimePath);
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
      throw new CloudResultStoreFailure();
    }
    chmodSync(runtimePath, ROOT_MODE);

    const root = join(runtimePath, CLOUD_RESULT_DIRECTORY);
    if (existsSync(root)) {
      const existing = lstatSync(root);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new CloudResultStoreFailure();
      }
    } else {
      mkdirSync(root, { recursive: false, mode: ROOT_MODE });
    }
    chmodSync(root, ROOT_MODE);
    const resolvedRuntime = realpath(runtimePath);
    const resolvedRoot = realpath(root);
    if (!isContained(resolvedRuntime, resolvedRoot) || resolvedRuntime === resolvedRoot) {
      throw new CloudResultStoreFailure();
    }
    this.root = resolvedRoot;
  }

  write(requestId: string, bytes: Uint8Array): void {
    const partial = this.path(requestId, 'partial');
    const complete = this.path(requestId, 'complete');
    if (bytes.byteLength <= 0) throw new CloudResultStoreFailure();
    if (statsFor(complete) !== null) throw new CloudResultStoreFailure();
    let descriptor: number | undefined;
    let createdPartial = false;
    let promoted = false;
    try {
      // wx prevents a pre-created symlink or file from being followed or replaced.
      descriptor = openSync(partial, 'wx', FILE_MODE);
      createdPartial = true;
      const buffer = Buffer.from(bytes);
      let offset = 0;
      while (offset < buffer.byteLength) offset += writeSync(descriptor, buffer, offset);
      fsyncSync(descriptor);
      chmodSync(partial, FILE_MODE);
      closeSync(descriptor);
      descriptor = undefined;
      // linkSync publishes a complete name without the overwrite behavior of renameSync. The
      // partial name is removed only after the complete hard link is visible.
      linkSync(partial, complete);
      promoted = true;
      unlinkSync(partial);
      syncDirectory(this.root);
      const promotedStat = statsFor(complete);
      if (promotedStat === null || promotedStat.isSymbolicLink() || !promotedStat.isFile()) {
        throw new CloudResultStoreFailure();
      }
      if (promotedStat.size !== bytes.byteLength) throw new CloudResultStoreFailure();
      chmodSync(complete, FILE_MODE);
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the bounded storage failure; reconciliation retries any leftover partial.
        }
      }
      // Never remove a complete artifact that predated this write attempt. This is safe even when
      // a replay writer races the first publisher: linkSync fails for the loser.
      if (promoted || createdPartial) {
        try {
          unlinkSync(promoted ? complete : partial);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            // A later reconciliation pass retries failed unlink operations.
          }
        }
      }
      throw new CloudResultStoreFailure();
    }
  }

  hasCompleteArtifact(requestId: string): boolean {
    return statsFor(this.path(requestId, 'complete')) !== null;
  }

  hasExactBytes(requestId: string, bytes: Uint8Array): boolean {
    const path = this.path(requestId, 'complete');
    const stat = statsFor(path);
    if (
      stat === null ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== bytes.byteLength
    ) {
      return false;
    }
    return readFileSync(path).equals(Buffer.from(bytes));
  }

  read(requestId: string): Buffer {
    const path = this.path(requestId, 'complete');
    const stat = statsFor(path);
    if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
      throw new CloudResultStoreFailure();
    }
    return readFileSync(path);
  }

  remove(requestId: string): void {
    for (const kind of ['partial', 'complete'] as const) {
      const path = this.path(requestId, kind);
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CloudResultStoreFailure();
        }
      }
    }
    syncDirectory(this.root);
  }

  list(): readonly CloudResultArtifact[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      throw new CloudResultStoreFailure();
    }
    return entries
      .map((entry) => this.describeEntry(entry))
      .filter((entry): entry is CloudResultArtifact => entry !== null);
  }

  listEntryNames(): readonly string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true }).map((entry) => entry.name);
    } catch {
      throw new CloudResultStoreFailure();
    }
  }

  removeEntry(entry: CloudResultArtifact): void {
    const path = this.path(entry.requestId, entry.kind);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new CloudResultStoreFailure();
      }
    }
    syncDirectory(this.root);
  }

  /** Remove unrecognized files without traversing or deleting unexpected directories. */
  removeUnknownEntries(knownRequestIds: ReadonlySet<string>): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      throw new CloudResultStoreFailure();
    }
    let removed = false;
    for (const entry of entries) {
      const artifact = this.describeEntry(entry);
      if (artifact !== null && knownRequestIds.has(artifact.requestId)) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) continue;
      try {
        unlinkSync(join(this.root, entry.name));
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new CloudResultStoreFailure();
        }
      }
    }
    if (removed) syncDirectory(this.root);
  }

  private describeEntry(entry: Dirent): CloudResultArtifact | null {
    const partial = entry.name.endsWith('.partial');
    const complete = entry.name.endsWith('.json');
    if (!partial && !complete) return null;
    const requestId = entry.name.slice(0, partial ? -'.partial'.length : -'.json'.length);
    if (!safeRequestId(requestId)) return null;
    const path = join(this.root, entry.name);
    if (!isContained(this.root, path)) return null;
    const stat = statsFor(path);
    if (stat === null) return null;
    return {
      requestId,
      kind: partial ? 'partial' : 'complete',
      size: stat.isFile() && !stat.isSymbolicLink() ? stat.size : null,
      modifiedAtMs: stat.mtimeMs,
      regular: stat.isFile() && !stat.isSymbolicLink(),
    };
  }

  private path(requestId: string, kind: CloudResultArtifactKind): string {
    if (!safeRequestId(requestId)) throw new CloudResultStoreFailure();
    const candidate = join(this.root, artifactName(requestId, kind));
    if (!isContained(this.root, candidate)) throw new CloudResultStoreFailure();
    return candidate;
  }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    throw new CloudResultStoreFailure();
  }
}
