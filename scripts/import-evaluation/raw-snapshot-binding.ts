import { createHash } from 'node:crypto';

export const RAW_SNAPSHOT_BINDING_SCHEMA_VERSION =
  'alyte.import-eval.raw-snapshot-binding.v1' as const;

export type RawSnapshotIdentity = {
  readonly reportSha256: string;
  readonly readerVersion: string;
  readonly runtimeVersion: string;
  readonly readerBinarySha256: string;
  readonly readerSourceSha256: string;
};

export type RawSnapshotBinding = RawSnapshotIdentity & {
  readonly schemaVersion: typeof RAW_SNAPSHOT_BINDING_SCHEMA_VERSION;
  readonly snapshotSha256: string;
};

export type RawSnapshotEnvelope = {
  readonly readerVersion: string;
  readonly reportSha256: string;
  readonly runtimeVersion: string;
  readonly [key: string]: unknown;
};

const SHA256 = /^[a-f0-9]{64}$/u;

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`raw-snapshot-${field}-invalid`);
  }
  return value;
}

function requireHash(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!SHA256.test(result)) throw new Error(`raw-snapshot-${field}-invalid`);
  return result;
}

function identityFields(value: unknown): RawSnapshotIdentity {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('raw-snapshot-binding-invalid');
  }
  const record = value as Record<string, unknown>;
  return {
    reportSha256: requireHash(record.reportSha256, 'report-hash'),
    readerVersion: requireString(record.readerVersion, 'reader-version'),
    runtimeVersion: requireString(record.runtimeVersion, 'runtime-version'),
    readerBinarySha256: requireHash(record.readerBinarySha256, 'reader-binary-hash'),
    readerSourceSha256: requireHash(record.readerSourceSha256, 'reader-source-hash'),
  };
}

export function createRawSnapshotBinding(
  rawText: string,
  identity: RawSnapshotIdentity,
): RawSnapshotBinding {
  const checked = identityFields(identity);
  return {
    schemaVersion: RAW_SNAPSHOT_BINDING_SCHEMA_VERSION,
    ...checked,
    snapshotSha256: sha256(rawText),
  };
}

/**
 * Verify a raw native reader output and its private binding record before reuse or parsing.
 * This function intentionally returns the untrusted envelope only after all identity checks pass.
 */
export function verifyRawSnapshotBinding(
  rawText: string,
  bindingValue: unknown,
  expected: RawSnapshotIdentity,
): RawSnapshotEnvelope {
  const binding = bindingValue;
  if (binding === null || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error('raw-snapshot-binding-invalid');
  }
  const record = binding as Record<string, unknown>;
  if (record.schemaVersion !== RAW_SNAPSHOT_BINDING_SCHEMA_VERSION) {
    throw new Error('raw-snapshot-binding-schema-invalid');
  }
  const actual = identityFields(record);
  const checkedExpected = identityFields(expected);
  for (const field of [
    'reportSha256',
    'readerVersion',
    'runtimeVersion',
    'readerBinarySha256',
    'readerSourceSha256',
  ] as const) {
    if (actual[field] !== checkedExpected[field]) {
      throw new Error(`raw-snapshot-${field}-mismatch`);
    }
  }
  if (record.snapshotSha256 !== sha256(rawText)) {
    throw new Error('raw-snapshot-content-mismatch');
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error('raw-snapshot-json-invalid');
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('raw-snapshot-envelope-invalid');
  }
  const parsed = envelope as Record<string, unknown>;
  if (
    parsed.reportSha256 !== checkedExpected.reportSha256 ||
    parsed.readerVersion !== checkedExpected.readerVersion ||
    parsed.runtimeVersion !== checkedExpected.runtimeVersion
  ) {
    throw new Error('raw-snapshot-envelope-binding-mismatch');
  }
  return envelope as RawSnapshotEnvelope;
}
