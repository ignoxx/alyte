import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const DEFAULT_LOCAL_RUNTIME_PATH = join(tmpdir(), 'alyte-api');
export const SESSION_HASH_SECRET_FILENAME = '.alyte-session-hash-secret';

function validateSecret(secret: Uint8Array): Uint8Array {
  if (secret.length < 32) {
    throw new Error('session_hash_secret_too_short');
  }
  return secret;
}

export function validateRuntimePath(runtimePath: string, production: boolean): string {
  if (!isAbsolute(runtimePath) || runtimePath === '/') {
    throw new Error('absolute_persistent_runtime_path_required');
  }
  if (production && runtimePath.trim().length === 0) {
    throw new Error('persistent_runtime_path_required');
  }
  mkdirSync(runtimePath, { recursive: true });
  return runtimePath;
}

export function loadSessionHashSecret(
  runtimePath: string,
  options: {
    readonly production: boolean;
    readonly configured?: string | Uint8Array | undefined;
  },
): Uint8Array {
  const configured = options.configured ?? process.env.ALYTE_SESSION_HASH_SECRET;
  if (configured !== undefined) {
    const secret =
      typeof configured === 'string' ? new TextEncoder().encode(configured) : configured;
    return validateSecret(secret);
  }
  if (options.production) {
    throw new Error('ALYTE_SESSION_HASH_SECRET is required in production');
  }

  const secretPath = join(runtimePath, SESSION_HASH_SECRET_FILENAME);
  try {
    const existing = readFileSync(secretPath);
    chmodSync(secretPath, 0o600);
    return validateSecret(existing);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }

  const generated = randomBytes(32);
  try {
    writeFileSync(secretPath, generated, { flag: 'wx', mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw error;
    }
    const existing = readFileSync(secretPath);
    chmodSync(secretPath, 0o600);
    return validateSecret(existing);
  }
}
