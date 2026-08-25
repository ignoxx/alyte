import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertDiagnosticsPayload, createDiagnosticsPayload } from './diagnostics';

test('diagnostics payload is allowlisted and contains no automatic health attachment shape', () => {
  const payload = createDiagnosticsPayload({
    appVersion: '0.1.0',
    variant: 'development',
    osMajor: 26,
    localStorage: 'available',
    protectedFiles: 'available',
    failures: ['database-failed'],
  });
  assert.deepEqual(payload.capabilities.model, 'not-managed-here');
  assert.doesNotThrow(() => assertDiagnosticsPayload(payload));
  assert.throws(
    () => assertDiagnosticsPayload({ ...payload, healthData: { value: 'secret' } }),
    /not allowlisted/i,
  );
  assert.throws(
    () => assertDiagnosticsPayload({ ...payload, failures: ['provider-raw-error'] }),
    /unsupported failure/i,
  );
  assert.throws(
    () => assertDiagnosticsPayload({ ...payload, capabilities: undefined }),
    /incomplete/i,
  );
  assert.throws(
    () =>
      assertDiagnosticsPayload({
        ...payload,
        capabilities: { ...payload.capabilities, nested: { ocr: 'secret' } },
      }),
    /not allowlisted/i,
  );
});
