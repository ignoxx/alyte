import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  APPLE_EXCHANGE_PATH,
  CLOUD_ALLOWANCES_PATH,
  CLOUD_PLAN_OFFERS,
  CLOUD_PRODUCT_IDS,
  CONSENT_POLICY_VERSION,
  CONTRACT_VERSION,
  type AppleExchangeRequest,
} from './index.js';

type RequiredProperty<T, K extends keyof T> = {} extends Pick<T, K> ? never : true;

describe('cloud contracts', () => {
  it('has an explicit version', () => {
    assert.match(CONTRACT_VERSION, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(CONTRACT_VERSION, '2026-08-27');
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
});
