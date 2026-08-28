import {
  CLOUD_REQUEST_MAX_BYTES,
  type CloudRequestOperation,
  type CloudResultEnvelope,
} from '@alyte/contracts';
import type {
  AccountDatabase,
  AnalysisJobRow,
  CloudProcessingFailureCategory,
} from './database.js';
import {
  CloudResultCryptoFailure,
  encryptCloudResult,
  type CloudResultEncryptionInput,
} from './cloud-result-crypto.js';
import {
  CloudResultFailure,
  type CloudResultService,
  type CloudResultLease,
} from './cloud-result.js';
import type { TransientUploadStore } from './transient-upload-store.js';
import { isCloudProcessingFailureCategory } from './cloud-processing.js';
import type {
  AnalysisJobHandler,
  AnalysisJobHandlerContext,
  AnalysisJobOutcome,
} from './worker.js';

/** The fixture-only schema used to prove the shared worker/result lifecycle. */
export const SYNTHETIC_RESULT_SCHEMA_VERSION = 'alyte.synthetic.result.v1' as const;

export interface CloudProcessingAdapterContext {
  readonly operation: CloudRequestOperation;
  readonly contractVersion: string;
  readonly resultSchemaVersion: string;
  readonly handlerVersion: number;
}

/**
 * Provider adapters return only a bounded typed refusal/failure or an untrusted result value.
 * The result value is not trusted until the operation-specific validator accepts it.
 */
export type CloudProcessingAdapterOutcome =
  | { readonly type: 'usable'; readonly output: unknown }
  | { readonly type: 'failure'; readonly category: CloudProcessingFailureCategory };

export interface CloudProcessingAdapter {
  process(
    bytes: Uint8Array,
    context: CloudProcessingAdapterContext,
  ): CloudProcessingAdapterOutcome | Promise<CloudProcessingAdapterOutcome>;
}

/** A provider-neutral way to signal one of the closed #122 outcomes without carrying a message. */
export class CloudProcessingAdapterFailure extends Error {
  constructor(readonly category: CloudProcessingFailureCategory) {
    super('cloud_processing_adapter_failure');
    this.name = 'CloudProcessingAdapterFailure';
  }
}

export interface SyntheticResult {
  readonly schemaVersion: typeof SYNTHETIC_RESULT_SCHEMA_VERSION;
  readonly operation: CloudRequestOperation;
  readonly inputByteCount: number;
  readonly accepted: true;
}

export interface SyntheticResultValidationContext {
  readonly operation: CloudRequestOperation;
  readonly inputByteCount: number;
}

const SYNTHETIC_RESULT_KEYS = ['accepted', 'inputByteCount', 'operation', 'schemaVersion'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactlyKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...SYNTHETIC_RESULT_KEYS].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validInputByteCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= CLOUD_REQUEST_MAX_BYTES
  );
}

function invalidSyntheticResult(): never {
  throw new Error('synthetic_result_invalid');
}

/** Strictly decode the fixture result; no provider text or extra fields are accepted. */
export function decodeSyntheticResult(
  value: unknown,
  context: SyntheticResultValidationContext,
): SyntheticResult {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value) ||
    value.schemaVersion !== SYNTHETIC_RESULT_SCHEMA_VERSION ||
    (value.operation !== 'intake-image' && value.operation !== 'lab-report') ||
    value.operation !== context.operation ||
    !validInputByteCount(value.inputByteCount) ||
    value.inputByteCount !== context.inputByteCount ||
    value.accepted !== true
  ) {
    invalidSyntheticResult();
  }
  return Object.freeze({
    schemaVersion: SYNTHETIC_RESULT_SCHEMA_VERSION,
    operation: value.operation,
    inputByteCount: value.inputByteCount,
    accepted: true,
  });
}

export const validateSyntheticResult = decodeSyntheticResult;

/** Canonical UTF-8 fixture bytes. The caller owns and zeroes the returned plaintext buffer. */
export function serializeSyntheticResult(
  value: unknown,
  context: SyntheticResultValidationContext,
): Buffer {
  const result = decodeSyntheticResult(value, context);
  return Buffer.from(
    JSON.stringify({
      schemaVersion: result.schemaVersion,
      operation: result.operation,
      inputByteCount: result.inputByteCount,
      accepted: result.accepted,
    }),
    'utf8',
  );
}

export interface CloudProcessingHandlerOptions {
  readonly database: AccountDatabase;
  readonly uploadStore: TransientUploadStore;
  readonly results: CloudResultService;
  readonly adapter: CloudProcessingAdapter;
  /** Internal test seam; production uses the #118 reference implementation. */
  readonly encrypt?: (input: CloudResultEncryptionInput) => CloudResultEnvelope;
}

function failure(category: CloudProcessingFailureCategory): AnalysisJobOutcome {
  return { type: 'failure', category };
}

function adapterFailure(category: CloudProcessingFailureCategory): CloudProcessingAdapterOutcome {
  return { type: 'failure', category };
}

function leaseFor(job: AnalysisJobRow): CloudResultLease | undefined {
  return job.lease_owner === null ? undefined : { jobId: job.id, leaseOwner: job.lease_owner };
}

function isLeaseRace(error: unknown): boolean {
  return (
    error instanceof CloudResultFailure &&
    (error.code === 'cloud_result_context_mismatch' ||
      error.code === 'cloud_result_conflict' ||
      error.code === 'cloud_result_not_available')
  );
}

function decodeAdapterOutcome(value: unknown): CloudProcessingAdapterOutcome {
  if (!isRecord(value)) return adapterFailure('malformed_output');
  const keys = Object.keys(value).sort();
  if (value.type === 'failure') {
    if (keys.length !== 2 || keys[0] !== 'category' || keys[1] !== 'type') {
      return adapterFailure('malformed_output');
    }
    return isCloudProcessingFailureCategory(value.category)
      ? { type: 'failure', category: value.category }
      : adapterFailure('malformed_output');
  }
  if (value.type === 'usable') {
    if (keys.length !== 2 || keys[0] !== 'output' || keys[1] !== 'type') {
      return adapterFailure('malformed_output');
    }
    return { type: 'usable', output: value.output };
  }
  return adapterFailure('malformed_output');
}

function adapterFailureCategory(error: unknown): CloudProcessingFailureCategory {
  if (error instanceof CloudProcessingAdapterFailure) {
    return isCloudProcessingFailureCategory(error.category) ? error.category : 'malformed_output';
  }
  return 'provider_failure';
}

function adapterContext(
  job: AnalysisJobRow,
  operation: CloudRequestOperation,
  contractVersion: string,
): CloudProcessingAdapterContext {
  return Object.freeze({
    operation,
    contractVersion,
    resultSchemaVersion: job.schema_version,
    handlerVersion: job.handler_version,
  });
}

function validVersion(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/**
 * Compose one synthetic operation through the existing lease, failure, encryption, and result
 * boundaries. No instance is created by the production server; a real provider must be supplied
 * explicitly by a later operation ticket.
 */
export function createCloudProcessingHandler(
  options: CloudProcessingHandlerOptions,
): AnalysisJobHandler {
  const encrypt = options.encrypt ?? encryptCloudResult;
  return async (
    job: AnalysisJobRow,
    handlerContext: AnalysisJobHandlerContext,
  ): Promise<AnalysisJobOutcome | undefined> => {
    const lease = leaseFor(job);
    if (lease === undefined) return;
    const request = options.database.findCloudRequestById(job.request_id);
    if (
      request === undefined ||
      request.state !== 'queued' ||
      request.contract_version !== job.request_contract_version
    ) {
      return;
    }
    if (
      (request.operation !== 'intake-image' && request.operation !== 'lab-report') ||
      !validVersion(request.contract_version) ||
      !validVersion(job.schema_version) ||
      !Number.isSafeInteger(job.handler_version) ||
      job.handler_version < 1 ||
      job.handler_version > 1_000
    ) {
      return failure('malformed_output');
    }

    // A staged result is the durable post-provider recovery path. It must never invoke the
    // adapter again, including after a process restart or a lease reclaim.
    const existing = options.database.findCloudResultCache(request.id);
    if (existing?.state === 'staged') {
      try {
        options.results.finalize(lease);
        return { type: 'completed' };
      } catch (error) {
        if (isLeaseRace(error)) return;
        throw error;
      }
    }
    if (existing !== undefined) return;

    // Fail closed before reading transient bytes: a lost lease must not cause provider work.
    if (handlerContext.heartbeat() !== 'renewed') return;

    let bytes: Buffer | undefined;
    try {
      try {
        bytes = options.uploadStore.read(request.id);
        if (bytes.byteLength !== request.byte_count) return failure('provider_failure');
      } catch {
        return failure('provider_failure');
      }

      const context = adapterContext(job, request.operation, request.contract_version);
      let adapterOutcome: CloudProcessingAdapterOutcome;
      try {
        adapterOutcome = decodeAdapterOutcome(await options.adapter.process(bytes, context));
      } catch (error) {
        return failure(adapterFailureCategory(error));
      }
      if (adapterOutcome.type === 'failure') return adapterOutcome;

      // Validate and canonicalize before encryption. No readable provider output reaches the
      // crypto or result-store boundary.
      let plaintext: Buffer | undefined;
      try {
        try {
          plaintext = serializeSyntheticResult(adapterOutcome.output, {
            operation: request.operation,
            inputByteCount: bytes.byteLength,
          });
        } catch {
          return failure('malformed_output');
        }
        if (handlerContext.heartbeat() !== 'renewed') return;
        let envelope: CloudResultEnvelope;
        try {
          const devicePublicKeyJwk = JSON.parse(request.device_public_key_jwk) as unknown;
          envelope = encrypt({
            requestId: request.id,
            contractVersion: request.contract_version,
            resultSchemaVersion: job.schema_version,
            handlerVersion: job.handler_version,
            devicePublicKeyJwk,
            plaintext,
          });
        } catch (error) {
          // Key/context/crypto errors are deliberately indistinguishable from malformed output
          // at the provider policy boundary and cannot expose the underlying error text.
          if (error instanceof CloudResultCryptoFailure) return failure('malformed_output');
          return failure('malformed_output');
        }
        // Do not stage an encrypted result after the lease has been lost. The envelope is only
        // in memory here and will be reclaimed safely without charging.
        if (handlerContext.heartbeat() !== 'renewed') return;
        try {
          options.results.stage(lease, envelope);
        } catch (error) {
          if (isLeaseRace(error)) return;
          if (
            error instanceof CloudResultFailure &&
            error.code === 'cloud_result_envelope_invalid'
          ) {
            return failure('malformed_output');
          }
          // A promoted ciphertext without metadata is a restart/reconciliation seam. Let the
          // result service repair it before the runner considers another provider attempt.
          if (
            error instanceof CloudResultFailure &&
            error.code === 'cloud_result_storage_failure'
          ) {
            try {
              options.results.reconcile();
            } catch {
              // The original bounded storage failure remains the only observable outcome.
            }
          }
          throw error;
        }
        try {
          options.results.finalize(lease);
          return { type: 'completed' };
        } catch (error) {
          if (isLeaseRace(error)) return;
          throw error;
        }
      } finally {
        plaintext?.fill(0);
        plaintext = undefined;
      }
    } finally {
      // The uploaded source and adapter-owned readable output never cross this process boundary.
      bytes?.fill(0);
      bytes = undefined;
    }
  };
}

/** Explicit name for callers/tests that want to emphasize this is fixture-only composition. */
export const createSyntheticCloudProcessingHandler = createCloudProcessingHandler;
