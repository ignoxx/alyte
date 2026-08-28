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
  renameSync,
  unlinkSync,
  writeSync,
  type Dirent,
  type Stats,
} from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const ROOT_MODE = 0o700;
const FILE_MODE = 0o600;

export const TRANSIENT_UPLOAD_DIRECTORY = 'cloud-uploads';

export class TransientUploadFailure extends Error {
  readonly code = 'cloud_upload_filesystem_failure';

  constructor() {
    super('cloud_upload_filesystem_failure');
    this.name = 'TransientUploadFailure';
  }
}

export type TransientArtifactKind = 'partial' | 'complete';

export interface TransientArtifact {
  readonly requestId: string;
  readonly kind: TransientArtifactKind;
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

function artifactName(requestId: string, kind: TransientArtifactKind): string {
  return `${requestId}.${kind === 'partial' ? 'partial' : 'bin'}`;
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
 * Owns the only server-side path where admitted cloud bytes may exist. All names are derived from
 * server-generated request IDs; caller paths and filenames are intentionally not accepted.
 */
export class TransientUploadStore {
  readonly root: string;

  constructor(runtimePath: string) {
    if (!isAbsolute(runtimePath) || runtimePath === '/') throw new TransientUploadFailure();
    mkdirSync(runtimePath, { recursive: true, mode: ROOT_MODE });
    const runtimeStat = lstatSync(runtimePath);
    if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
      throw new TransientUploadFailure();
    }
    chmodSync(runtimePath, ROOT_MODE);

    const root = join(runtimePath, TRANSIENT_UPLOAD_DIRECTORY);
    if (existsSync(root)) {
      const existing = lstatSync(root);
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new TransientUploadFailure();
    } else {
      mkdirSync(root, { recursive: false, mode: ROOT_MODE });
    }
    chmodSync(root, ROOT_MODE);
    const resolvedRuntime = realpath(runtimePath);
    const resolvedRoot = realpath(root);
    if (!isContained(resolvedRuntime, resolvedRoot) || resolvedRuntime === resolvedRoot) {
      throw new TransientUploadFailure();
    }
    this.root = resolvedRoot;
  }

  write(requestId: string, bytes: Uint8Array, expectedBytes: number): void {
    const partial = this.path(requestId, 'partial');
    const complete = this.path(requestId, 'complete');
    if (bytes.byteLength !== expectedBytes || expectedBytes <= 0)
      throw new TransientUploadFailure();
    if (statsFor(complete) !== null) throw new TransientUploadFailure();
    let descriptor: number | undefined;
    let createdPartial = false;
    let promoted = false;
    try {
      // wx prevents a pre-created symlink or file from being followed/replaced.
      descriptor = openSync(partial, 'wx', FILE_MODE);
      createdPartial = true;
      const buffer = Buffer.from(bytes);
      let offset = 0;
      while (offset < buffer.byteLength) offset += writeSync(descriptor, buffer, offset);
      fsyncSync(descriptor);
      chmodSync(partial, FILE_MODE);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(partial, complete);
      promoted = true;
      chmodSync(complete, FILE_MODE);
      syncDirectory(this.root);
      const promotedStat = statsFor(complete);
      if (promotedStat === null || promotedStat.isSymbolicLink() || !promotedStat.isFile()) {
        throw new TransientUploadFailure();
      }
      if (promotedStat.size !== expectedBytes) throw new TransientUploadFailure();
    } catch {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {
          // Preserve the bounded upload failure; cleanup below remains best effort.
        }
      }
      // Never remove a complete artifact that predated this write attempt. This matters when two
      // processes race a replay: the losing writer may see the winner's promoted file.
      if (promoted || createdPartial) {
        try {
          unlinkSync(promoted ? complete : partial);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            // Keep the bounded filesystem error below; reconciliation retries any leftover partial.
          }
        }
      }
      throw new TransientUploadFailure();
    }
  }

  hasExactSize(requestId: string, expectedBytes: number): boolean {
    const stat = statsFor(this.path(requestId, 'complete'));
    return stat !== null && stat.isFile() && !stat.isSymbolicLink() && stat.size === expectedBytes;
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
    // This digest exists only in process memory for replay comparison and is never persisted.
    const existing = readFileSync(path);
    return existing.equals(Buffer.from(bytes));
  }

  read(requestId: string): Buffer {
    const path = this.path(requestId, 'complete');
    const stat = statsFor(path);
    if (stat === null || !stat.isFile() || stat.isSymbolicLink())
      throw new TransientUploadFailure();
    return readFileSync(path);
  }

  remove(requestId: string): void {
    for (const kind of ['partial', 'complete'] as const) {
      const path = this.path(requestId, kind);
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new TransientUploadFailure();
      }
    }
    try {
      syncDirectory(this.root);
    } catch {
      throw new TransientUploadFailure();
    }
  }

  list(): readonly TransientArtifact[] {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      throw new TransientUploadFailure();
    }
    return entries
      .map((entry) => this.describeEntry(entry))
      .filter((entry): entry is TransientArtifact => entry !== null);
  }

  listEntryNames(): readonly string[] {
    try {
      return readdirSync(this.root, { withFileTypes: true }).map((entry) => entry.name);
    } catch {
      throw new TransientUploadFailure();
    }
  }

  removeEntry(entry: TransientArtifact): void {
    const path = this.path(entry.requestId, entry.kind);
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new TransientUploadFailure();
      }
    }
    try {
      syncDirectory(this.root);
    } catch {
      throw new TransientUploadFailure();
    }
  }

  /** Remove unrecognized files without ever traversing or deleting unexpected directories. */
  removeUnknownEntries(knownRequestIds: ReadonlySet<string>): void {
    let entries: Dirent[];
    try {
      entries = readdirSync(this.root, { withFileTypes: true });
    } catch {
      throw new TransientUploadFailure();
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
          throw new TransientUploadFailure();
        }
      }
    }
    if (removed) {
      try {
        syncDirectory(this.root);
      } catch {
        throw new TransientUploadFailure();
      }
    }
  }

  private describeEntry(entry: Dirent): TransientArtifact | null {
    const partial = entry.name.endsWith('.partial');
    const complete = entry.name.endsWith('.bin');
    if (!partial && !complete) return null;
    const requestId = entry.name.slice(0, partial ? -'.partial'.length : -'.bin'.length);
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

  private path(requestId: string, kind: TransientArtifactKind): string {
    if (!safeRequestId(requestId)) throw new TransientUploadFailure();
    const candidate = join(this.root, artifactName(requestId, kind));
    if (!isContained(this.root, candidate)) throw new TransientUploadFailure();
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
  // Keep this wrapper local so all path resolution occurs before any artifact operation.
  try {
    return realpathSync(path);
  } catch {
    throw new TransientUploadFailure();
  }
}
