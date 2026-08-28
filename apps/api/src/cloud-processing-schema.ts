/**
 * The only result schema currently admitted by the dormant handler-v1 synthetic composition.
 * Keeping this value separate lets request admission, worker composition, and tests share one
 * immutable context without importing the handler (or creating a provider registry).
 */
export const SYNTHETIC_RESULT_SCHEMA_VERSION = 'alyte.synthetic.result.v1' as const;
