import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLE_EXCHANGE_PATH,
  CLOUD_ALLOWANCES_PATH,
  CLOUD_REQUEST_CANCEL_PATH,
  CLOUD_REQUEST_COMPLETE_UPLOAD_PATH,
  CLOUD_REQUEST_UPLOAD_PATH,
  CLOUD_REQUEST_MAX_BYTES,
  CLOUD_REQUEST_MAX_PAGES,
  CLOUD_REQUEST_STATUS_PATH,
  CLOUD_REQUESTS_PATH,
  CLOUD_PLAN_OFFERS,
  CLOUD_PRODUCT_IDS,
  CONSENT_POLICY_VERSION,
  CONTRACT_VERSION,
  type AppleExchangeRequest,
  type CloudRequestErrorCode,
  type CloudRequestState,
  type CloudRequestStatusResponse,
} from './index.js';

type RequiredProperty<T, K extends keyof T> = {} extends Pick<T, K> ? never : true;

describe('cloud contracts', () => {
  it('has an explicit version', () => {
    assert.match(CONTRACT_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(CONTRACT_VERSION, '2026-08-28');
    assert.equal(APPLE_EXCHANGE_PATH, '/v2/auth/apple/exchange');
  });

  it('requires the disclosed consent policy in Apple exchange requests', () => {
    const consentPolicyIsRequired: RequiredProperty<AppleExchangeRequest, 'consentPolicyVersion'> =
      true;
    const rawNonceIsRequired: RequiredProperty<AppleExchangeRequest, 'rawNonce'> = true;
    const request: AppleExchangeRequest = {
      identityToken: 'synthetic-token',
      rawNonce: '0123456789ABCDEFGHIJKLMNOPQRSTUV',
      consentPolicyVersion: CONSENT_POLICY_VERSION,
    };
    assert.equal(consentPolicyIsRequired, true);
    assert.equal(rawNonceIsRequired, true);
    assert.equal(request.consentPolicyVersion, CONSENT_POLICY_VERSION);
  });

  it('keeps commerce products and allowance boundaries explicit', () => {
    assert.equal(CLOUD_ALLOWANCES_PATH, '/v1/cloud/allowances');
    assert.equal(CLOUD_PLAN_OFFERS[0].productId, CLOUD_PRODUCT_IDS.starterPack);
    assert.equal(CLOUD_PLAN_OFFERS[0].recurring, false);
    assert.equal(CLOUD_PLAN_OFFERS[0].snapAllowance, 5);
    assert.equal(CLOUD_PLAN_OFFERS[0].reportAllowance, 1);
    assert.equal(CLOUD_PLAN_OFFERS[1].snapAllowance, 500);
    assert.equal(CLOUD_PLAN_OFFERS[1].reportAllowance, 4);
  });

  it('defines the bounded cloud admission/status/cancellation contract', () => {
    assert.equal(CLOUD_REQUESTS_PATH, '/v1/cloud-requests');
    assert.equal(CLOUD_REQUEST_STATUS_PATH, '/v1/cloud-requests/:requestId');
    assert.equal(CLOUD_REQUEST_CANCEL_PATH, '/v1/cloud-requests/:requestId/cancel');
    assert.equal(CLOUD_REQUEST_UPLOAD_PATH, '/v1/cloud-requests/:requestId/upload');
    assert.equal(
      CLOUD_REQUEST_COMPLETE_UPLOAD_PATH,
      '/v1/cloud-requests/:requestId/complete-upload',
    );
    assert.equal(CLOUD_REQUEST_MAX_BYTES, 25 * 1024 * 1024);
    assert.equal(CLOUD_REQUEST_MAX_PAGES, 20);

    const states: readonly CloudRequestState[] = [
      'awaiting-upload',
      'uploaded',
      'queued',
      'cancelled',
      'expired',
    ];
    assert.deepEqual(states, ['awaiting-upload', 'uploaded', 'queued', 'cancelled', 'expired']);
    const errors: readonly CloudRequestErrorCode[] = [
      'cloud_request_invalid',
      'cloud_request_operation_invalid',
      'cloud_request_metadata_invalid',
      'cloud_request_contract_version_unsupported',
      'device_public_key_invalid',
      'idempotency_key_required',
      'idempotency_key_invalid',
      'idempotency_key_conflict',
      'cloud_request_not_found',
      'cloud_request_not_cancellable',
      'allowance_exhausted',
      'cloud_upload_content_type_invalid',
      'cloud_upload_body_invalid',
      'cloud_upload_too_large',
      'cloud_upload_too_small',
      'cloud_upload_conflict',
      'cloud_upload_filesystem_failure',
      'cloud_upload_artifact_missing',
      'cloud_upload_not_completeable',
      'cloud_upload_required',
      'cloud_request_expired',
    ];
    assert.deepEqual(errors, [
      'cloud_request_invalid',
      'cloud_request_operation_invalid',
      'cloud_request_metadata_invalid',
      'cloud_request_contract_version_unsupported',
      'device_public_key_invalid',
      'idempotency_key_required',
      'idempotency_key_invalid',
      'idempotency_key_conflict',
      'cloud_request_not_found',
      'cloud_request_not_cancellable',
      'allowance_exhausted',
      'cloud_upload_content_type_invalid',
      'cloud_upload_body_invalid',
      'cloud_upload_too_large',
      'cloud_upload_too_small',
      'cloud_upload_conflict',
      'cloud_upload_filesystem_failure',
      'cloud_upload_artifact_missing',
      'cloud_upload_not_completeable',
      'cloud_upload_required',
      'cloud_request_expired',
    ]);

    const storedVersionStatus: CloudRequestStatusResponse = {
      requestId: 'request-from-an-older-contract',
      operation: 'intake-image',
      state: 'awaiting-upload',
      byteCount: 1,
      pageCount: 1,
      contractVersion: '2026-08-27',
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
      cancelledAt: null,
    };
    assert.equal(storedVersionStatus.contractVersion, '2026-08-27');
  });
});
