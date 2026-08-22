import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION, type AppleExchangeRequest } from './index.js';

type RequiredProperty<T, K extends keyof T> = {} extends Pick<T, K> ? never : true;

describe('cloud contracts', () => {
  it('has an explicit version', () => {
    assert.match(CONTRACT_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });

  it('requires the disclosed consent policy in Apple exchange requests', () => {
    const consentPolicyIsRequired: RequiredProperty<AppleExchangeRequest, 'consentPolicyVersion'> =
      true;
    const request: AppleExchangeRequest = {
      identityToken: 'synthetic-token',
      consentPolicyVersion: CONTRACT_VERSION,
    };
    assert.equal(consentPolicyIsRequired, true);
    assert.equal(request.consentPolicyVersion, CONTRACT_VERSION);
  });
});
