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
  readonly status: CloudCommerceStatus;
  readonly offerings: readonly MobileOffering[];
  readonly allowance: CloudAllowanceResponse | null;
  readonly lastErrorCode: string | null;
};

export type CloudCommerceService = {
  readonly getSnapshot: () => CloudCommerceSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly load: () => Promise<void>;
  readonly purchase: (productId: CloudProductId) => Promise<void>;
  readonly restore: () => Promise<void>;
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
    status: 'idle',
    offerings: [],
    allowance: null,
    lastErrorCode: null,
  };
  let loadPromise: Promise<void> | null = null;

  function publish(next: Partial<CloudCommerceSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    listeners.forEach((listener) => listener());
  }

  async function accountId(): Promise<string> {
    const current = options.account.getSnapshot();
    if (!current.signedIn) throw new CloudApiError(401, 'session_required');
    if (current.accountId !== null) return current.accountId;
    return (await options.account.getAllowanceSummary()).accountId;
  }

  async function load(): Promise<void> {
    if (loadPromise !== null) return loadPromise;
    publish({ status: 'loading', lastErrorCode: null });
    const operation = (async () => {
      try {
        const id = await accountId();
        await adapter.configure(id);
        const [offerings, allowance] = await Promise.all([
          adapter.getOfferings(),
          options.account.getAllowanceSummary(),
        ]);
        publish({ status: 'ready', offerings, allowance, lastErrorCode: null });
      } catch (error) {
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
    void operation.finally(() => {
      if (loadPromise === operation) loadPromise = null;
    });
    return operation;
  }

  async function purchase(productId: CloudProductId): Promise<void> {
    try {
      const id = await accountId();
      publish({ status: 'purchasing', lastErrorCode: null });
      await adapter.configure(id);
      if (!snapshot.offerings.some((offering) => offering.productId === productId)) {
        const offerings = await adapter.getOfferings();
        publish({ offerings });
      }
      await adapter.purchase(productId);
      let reconciliation: CloudReconcileResponse;
      try {
        reconciliation = await options.account.reconcileAllowances();
      } catch (error) {
        publish({ status: 'pending', lastErrorCode: errorCode(error) });
        throw error;
      }
      publish({ status: 'ready', allowance: reconciliation, lastErrorCode: null });
    } catch (error) {
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
  }

  async function restore(): Promise<void> {
    try {
      const id = await accountId();
      publish({ status: 'restoring', lastErrorCode: null });
      await adapter.configure(id);
      await adapter.restore();
      const reconciliation = await options.account.reconcileAllowances();
      publish({ status: 'ready', allowance: reconciliation, lastErrorCode: null });
    } catch (error) {
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
  };
}
