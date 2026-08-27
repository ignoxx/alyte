import type {
  CloudAllowanceResponse,
  CloudProductId,
  CloudReconcileResponse,
} from '@alyte/contracts';
import { CloudApiError } from '../account/cloud-api';
import type { CloudAccountService } from '../account/service';
import {
  MobileCommerceError,
  createNativePurchaseAdapter,
  type MobileOffering,
  type PurchaseAdapter,
} from './purchases';

export type CloudCommerceStatus =
  'idle' | 'loading' | 'ready' | 'purchasing' | 'restoring' | 'pending' | 'offline' | 'unavailable';

export type CloudCommerceSnapshot = {
  readonly accountId: string | null;
  readonly status: CloudCommerceStatus;
  readonly offerings: readonly MobileOffering[];
  readonly allowance: CloudAllowanceResponse | null;
  readonly lastErrorCode: string | null;
  readonly pendingIntent: CloudPendingIntent | null;
};

export type CloudPendingIntent = {
  readonly operation: 'snap' | 'report';
};

export type CloudCommerceService = {
  readonly getSnapshot: () => CloudCommerceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  readonly purchase: (productId: CloudProductId) => Promise<void>;
  readonly restore: () => Promise<void>;
  readonly setPendingIntent: (intent: CloudPendingIntent | null) => void;
  readonly getPendingIntent: () => CloudPendingIntent | null;
};

export type CloudCommerceServiceOptions = {
  readonly account: CloudAccountService;
  readonly purchaseAdapter?: PurchaseAdapter;
};

function errorCode(error: unknown): string {
  if (error instanceof CloudApiError) return error.code;
  if (error instanceof MobileCommerceError) return error.code;
  return 'cloud_unavailable';
}

function offline(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'offline' || code === 'api_unconfigured' || code === 'request_timeout';
}

export function createCloudCommerceService(
  options: CloudCommerceServiceOptions,
): CloudCommerceService {
  const adapter = options.purchaseAdapter ?? createNativePurchaseAdapter();
  const listeners = new Set<() => void>();
  let snapshot: CloudCommerceSnapshot = {
    accountId: null,
    status: 'idle',
    offerings: [],
    allowance: null,
    lastErrorCode: null,
    pendingIntent: null,
  };
  let loadPromise: Promise<void> | null = null;
  let purchasePromise: Promise<void> | null = null;
  let restorePromise: Promise<void> | null = null;
  let accountGeneration = 0;
  let activeAccountId: string | null = currentAccountId();

  function publish(next: Partial<CloudCommerceSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  }

  function currentAccountId(): string | null {
    const current = options.account.getSnapshot();
    return current.signedIn ? current.accountId : null;
  }

  function isCurrentAccount(accountId: string, generation: number): boolean {
    return accountGeneration === generation && currentAccountId() === accountId;
  }

  options.account.subscribe(() => {
    const nextAccountId = currentAccountId();
    if (nextAccountId === activeAccountId) return;
    activeAccountId = nextAccountId;
    accountGeneration += 1;
    loadPromise = null;
    publish({
      accountId: nextAccountId,
      status: 'idle',
      offerings: [],
      allowance: null,
      lastErrorCode: null,
      pendingIntent: null,
    });
  });

  async function accountId(): Promise<string> {
    const current = options.account.getSnapshot();
    if (!current.signedIn) throw new CloudApiError(401, 'session_required');
    if (current.accountId !== null) return current.accountId;
    const result = await options.account.getAllowanceSummary();
    if (result.accountId.length === 0) throw new CloudApiError(502, 'account_mismatch');
    return result.accountId;
  }

  async function load(): Promise<void> {
    if (loadPromise !== null) return loadPromise;
    publish({ status: 'loading', lastErrorCode: null });
    let operationAccountId: string | null = null;
    const operationGeneration = accountGeneration;
    const operation = (async () => {
      try {
        const id = await accountId();
        operationAccountId = id;
        await adapter.configure(id);
        const [offerings, allowance] = await Promise.all([
          adapter.getOfferings(),
          options.account.getAllowanceSummary(),
        ]);
        if (!isCurrentAccount(id, operationGeneration) || allowance.accountId !== id) {
          if (isCurrentAccount(id, operationGeneration)) {
            throw new CloudApiError(502, 'account_mismatch');
          }
          return;
        }
        publish({ accountId: id, status: 'ready', offerings, allowance, lastErrorCode: null });
      } catch (error) {
        if (
          operationAccountId !== null &&
          !isCurrentAccount(operationAccountId, operationGeneration)
        ) {
          return;
        }
        publish({
          status: offline(error)
            ? 'offline'
            : error instanceof MobileCommerceError
              ? 'unavailable'
              : 'unavailable',
          lastErrorCode: errorCode(error),
        });
      }
    })();
    loadPromise = operation;
    void operation
      .finally(() => {
        if (loadPromise === operation) loadPromise = null;
      })
      .catch(() => undefined);
    return operation;
  }

  function purchase(productId: CloudProductId): Promise<void> {
    if (purchasePromise !== null) return purchasePromise;
    const operationGeneration = accountGeneration;
    let operationAccountId: string | null = null;
    const operation = (async () => {
      try {
        const id = await accountId();
        operationAccountId = id;
        publish({ status: 'purchasing', lastErrorCode: null });
        await adapter.configure(id);
        if (!snapshot.offerings.some((offering) => offering.productId === productId)) {
          const offerings = await adapter.getOfferings();
          if (isCurrentAccount(id, operationGeneration)) publish({ offerings });
        }
        await adapter.purchase(productId);
        let reconciliation: CloudReconcileResponse;
        try {
          reconciliation = await options.account.reconcileAllowances();
        } catch (error) {
          if (isCurrentAccount(id, operationGeneration)) {
            publish({ status: 'pending', lastErrorCode: errorCode(error) });
          }
          throw error;
        }
        if (!isCurrentAccount(id, operationGeneration)) return;
        if (!purchaseConfirmed(productId, reconciliation) || reconciliation.accountId !== id) {
          publish({ status: 'pending', lastErrorCode: 'purchase_pending_verification' });
          throw new CloudApiError(409, 'purchase_pending_verification');
        }
        publish({ accountId: id, status: 'ready', allowance: reconciliation, lastErrorCode: null });
      } catch (error) {
        if (
          operationAccountId !== null &&
          !isCurrentAccount(operationAccountId, operationGeneration)
        ) {
          throw error;
        }
        if (error instanceof MobileCommerceError && error.code === 'purchase_cancelled') {
          publish({ status: 'ready', lastErrorCode: null });
        } else if (snapshot.status !== 'pending') {
          publish({
            status: offline(error) ? 'offline' : 'unavailable',
            lastErrorCode: errorCode(error),
          });
        }
        throw error;
      }
    })();
    purchasePromise = operation;
    void operation
      .finally(() => {
        if (purchasePromise === operation) purchasePromise = null;
      })
      .catch(() => undefined);
    return operation;
  }

  function purchaseConfirmed(productId: CloudProductId, response: CloudReconcileResponse): boolean {
    const entitlement = response.entitlements.find(
      (item) =>
        item.productId === productId && (item.status === 'active' || item.status === 'pending'),
    );
    return entitlement !== undefined && response.allowances.some((item) => item.included > 0);
  }

  function restore(): Promise<void> {
    if (restorePromise !== null) return restorePromise;
    const operationGeneration = accountGeneration;
    let operationAccountId: string | null = null;
    const operation = (async () => {
      try {
        const id = await accountId();
        operationAccountId = id;
        publish({ status: 'restoring', lastErrorCode: null });
        await adapter.configure(id);
        await adapter.restore();
        const reconciliation = await options.account.reconcileAllowances();
        if (!isCurrentAccount(id, operationGeneration)) return;
        if (reconciliation.accountId !== id) throw new CloudApiError(502, 'account_mismatch');
        publish({ accountId: id, status: 'ready', allowance: reconciliation, lastErrorCode: null });
      } catch (error) {
        if (
          operationAccountId !== null &&
          !isCurrentAccount(operationAccountId, operationGeneration)
        ) {
          throw error;
        }
        if (error instanceof MobileCommerceError && error.code === 'purchase_cancelled') {
          publish({ status: 'ready', lastErrorCode: null });
        } else {
          publish({
            status: offline(error) ? 'offline' : 'unavailable',
            lastErrorCode: errorCode(error),
          });
        }
        throw error;
      }
    })();
    restorePromise = operation;
    void operation
      .finally(() => {
        if (restorePromise === operation) restorePromise = null;
      })
      .catch(() => undefined);
    return operation;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load,
    purchase,
    restore,
    setPendingIntent(intent) {
      publish({ pendingIntent: intent });
    },
    getPendingIntent: () => snapshot.pendingIntent,
  };
}
