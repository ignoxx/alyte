import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_PRODUCT_IDS,
  type CloudAllowanceResponse,
  type CloudReconcileResponse,
} from '@alyte/contracts';
import type { CloudAccountService, CloudAccountSnapshot } from '../account/service';
import { CloudApiError } from '../account/cloud-api';
import { createCloudCommerceService } from './service';
import { createFakePurchaseAdapter } from './purchases';

const allowance: CloudAllowanceResponse = {
  accountId: 'opaque-account-id',
  entitlements: [
    {
      planId: 'starter_pack',
      productId: CLOUD_PRODUCT_IDS.starterPack,
      status: 'active',
      willRenew: false,
      periodStart: '2026-08-27T12:00:00.000Z',
      periodEnd: null,
    },
  ],
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

function fakeAccount(
  reconciliationFactory?: (accountId: string) => CloudReconcileResponse,
): CloudAccountService & {
  reconciles: number;
  setAccount: (accountId: string | null) => void;
} {
  let snapshot: CloudAccountSnapshot = {
    status: 'active',
    signedIn: true,
    accountId: 'opaque-account-id',
    lastErrorCode: null,
    pendingDeletion: false,
  };
  let reconciles = 0;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  const service = {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
      notify();
    },
    setAccount: (accountId: string | null) => {
      snapshot =
        accountId === null
          ? { ...snapshot, signedIn: false, accountId: null, status: 'signed-out' }
          : { ...snapshot, signedIn: true, accountId, status: 'active' };
      notify();
    },
    deleteAccount: async () => undefined,
    getAllowanceSummary: async () => ({
      ...allowance,
      accountId: snapshot.accountId ?? '',
    }),
    reconcileAllowances: async (): Promise<CloudReconcileResponse> => {
      reconciles += 1;
      return (
        reconciliationFactory?.(snapshot.accountId ?? '') ?? {
          ...allowance,
          accountId: snapshot.accountId ?? '',
          reconciled: true,
        }
      );
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

  it('clears account-bound commerce state across sign-out and reloads it for the next account', async () => {
    const account = fakeAccount();
    const adapter = createFakePurchaseAdapter();
    const commerce = createCloudCommerceService({ account, purchaseAdapter: adapter });
    await commerce.load();
    assert.equal(commerce.getSnapshot().accountId, 'opaque-account-id');
    commerce.setPendingIntent({ operation: 'report' });
    account.setAccount(null);
    assert.equal(commerce.getSnapshot().accountId, null);
    assert.equal(commerce.getSnapshot().allowance, null);
    assert.equal(commerce.getSnapshot().pendingIntent, null);
    account.setAccount('second-account');
    await commerce.load();
    assert.equal(commerce.getSnapshot().accountId, 'second-account');
    assert.equal(adapter.configuredAccountIds.at(-1), 'second-account');
  });

  it('keeps a StoreKit purchase pending until backend reconciliation names the product', async () => {
    const account = fakeAccount(() => ({
      ...allowance,
      entitlements: [],
      reconciled: true,
    }));
    const commerce = createCloudCommerceService({
      account,
      purchaseAdapter: createFakePurchaseAdapter(),
    });
    await assert.rejects(
      commerce.purchase(CLOUD_PRODUCT_IDS.starterPack),
      (error: unknown) =>
        error instanceof CloudApiError && error.code === 'purchase_pending_verification',
    );
    assert.equal(commerce.getSnapshot().status, 'pending');
  });
});
