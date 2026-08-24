import { readFileSync } from 'node:fs';
import { readFile as readFileAsync, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { createPrivateKey } from 'node:crypto';
import {
  canonicalJson,
  signCatalogueArtifact,
  type CatalogueArtifact,
  type CataloguePrivateSigningKey,
} from '../src/index';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function assertKnownOptions(options: readonly string[]): void {
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--') && !options.includes(argument))
      throw new Error(`unknown catalogue signing option: ${argument}`);
  }
}

async function readPrivateKeyMaterial(): Promise<string> {
  const envName = option('--private-key-env');
  if (envName !== undefined) {
    const value = process.env[envName];
    if (value === undefined || value.length === 0)
      throw new Error('private key environment input is empty');
    return value;
  }
  const fdValue = option('--private-key-fd');
  if (fdValue !== undefined) {
    const fd = Number(fdValue);
    if (!Number.isInteger(fd) || fd < 0) throw new Error('private key file descriptor is invalid');
    return readFileSync(fd, 'utf8');
  }
  if (process.argv.includes('--private-key-stdin')) {
    return new Promise<string>((resolveKey, reject) => {
      let value = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk: string) => {
        value += chunk;
      });
      process.stdin.on('end', () => resolveKey(value));
      process.stdin.on('error', reject);
    });
  }
  throw new Error(
    'private key input is required: use --private-key-stdin, --private-key-fd, or --private-key-env',
  );
}

function toPrivateJwk(
  material: string,
  algorithm: CataloguePrivateSigningKey['algorithm'],
): Record<string, unknown> {
  const trimmed = material.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // PEM is converted below without echoing the key material.
  }
  const nodeCrypto = requireNodeCrypto();
  const key = nodeCrypto.createPrivateKey({ key: trimmed, format: 'pem' });
  const jwk = key.export({ format: 'jwk' }) as Record<string, unknown>;
  if (algorithm === 'Ed25519' && jwk.kty !== 'OKP')
    throw new Error('private key algorithm does not match Ed25519');
  if (algorithm === 'ECDSA-P256-SHA256' && (jwk.kty !== 'EC' || jwk.crv !== 'P-256'))
    throw new Error('private key algorithm does not match ECDSA P-256');
  return jwk;
}

function requireNodeCrypto(): { readonly createPrivateKey: typeof createPrivateKey } {
  // Keep Node-only key-format handling in the offline CLI, not in the platform-neutral package.
  return createRequire(import.meta.url)('node:crypto') as {
    readonly createPrivateKey: typeof createPrivateKey;
  };
}

const input = option('--in');
assertKnownOptions([
  '--in',
  '--out',
  '--key-id',
  '--algorithm',
  '--private-key-env',
  '--private-key-fd',
  '--private-key-stdin',
]);
const output = option('--out');
const keyId = option('--key-id');
const algorithm = option('--algorithm') as CataloguePrivateSigningKey['algorithm'] | undefined;
if (input === undefined || output === undefined || keyId === undefined || algorithm === undefined) {
  throw new Error(
    'usage: --in artifact.json --out signed.json --key-id ID --algorithm ECDSA-P256-SHA256|Ed25519 plus secure key input',
  );
}
if (algorithm !== 'ECDSA-P256-SHA256' && algorithm !== 'Ed25519')
  throw new Error('unsupported signing algorithm');

const artifact = JSON.parse(await readFileAsync(resolve(input), 'utf8')) as CatalogueArtifact;
const privateKeyJwk = toPrivateJwk(await readPrivateKeyMaterial(), algorithm);
const signed = await signCatalogueArtifact(artifact, { keyId, algorithm, privateKeyJwk });
await writeFile(resolve(output), `${canonicalJson(signed)}\n`, 'utf8');
