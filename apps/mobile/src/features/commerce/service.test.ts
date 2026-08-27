import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_PRODUCT_IDS,
  type CloudAllowanceResponse,
  type CloudReconcileResponse,
} from '@alyte/contracts';
import type { CloudAccountService, CloudAccountSnapshot } from '../account/service';
import { createCloudCommerceService } from './service';
import { createFakePurchaseAdapter } from './purchases';

const allowance: CloudAllowanceResponse = {
  accountId: 'opaque-account-id',
  entitlements: [],
  allowances: [
    {
      kind: 'snap',
      included: 5,
      consumed: 0,
      reserved: 0,
      remaining: 5,
      warning: 'normal',
      resetAt: null,
    },
    {
      kind: 'report',
      included: 1,
      consumed: 0,
      reserved: 0,
      remaining: 1,
      warning: 'normal',
      resetAt: null,
    },
  ],
  managementUrl: null,
  generatedAt: '2026-08-27T12:00:00.000Z',
};

function fakeAccount(): CloudAccountService & { reconciles: number } {
  let snapshot: CloudAccountSnapshot = {
    status: 'active',
    signedIn: true,
    accountId: 'opaque-account-id',
    lastErrorCode: null,
    pendingDeletion: false,
  };
  let reconciles = 0;
  const service = {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    bootstrap: async () => undefined,
    isAppleSignInAvailable: async () => true,
    signInWithApple: async () => undefined,
    exportAccount: async () => {
      throw new Error('unused');
    },
    prepareAccountExport: async () => {
      throw new Error('unused');
    },
    signOut: async () => {
      snapshot = { ...snapshot, signedIn: false, accountId: null, status: 'signed-out' };
    },
    deleteAccount: async () => undefined,
    getAllowanceSummary: async () => allowance,
    reconcileAllowances: async (): Promise<CloudReconcileResponse> => {
      reconciles += 1;
      return { ...allowance, reconciled: true };
    },
    get reconciles() {
      return reconciles;
    },
  };
  return service;
}

describe('cloud commerce service', () => {
  it('configures lazily and only considers the backend response successful', async () => {
    const account = fakeAccount();
    const adapter = createFakePurchaseAdapter();
    const commerce = createCloudCommerceService({ account, purchaseAdapter: adapter });
    assert.equal(adapter.configuredAccountIds.length, 0);
    await commerce.load();
    assert.equal(adapter.configuredAccountIds.length, 1);
    assert.equal(commerce.getSnapshot().status, 'ready');
    await commerce.purchase(CLOUD_PRODUCT_IDS.starterPack);
    assert.equal(account.reconciles, 1);
    assert.equal(commerce.getSnapshot().status, 'ready');
  });
});
