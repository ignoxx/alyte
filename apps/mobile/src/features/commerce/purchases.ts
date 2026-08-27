import { CLOUD_PLAN_OFFERS, CLOUD_PRODUCT_IDS, type CloudProductId } from '@alyte/contracts';
import type Purchases from 'react-native-purchases';

export class MobileCommerceError extends Error {
  readonly code: 'store_unavailable' | 'purchase_cancelled' | 'purchase_failed';

  constructor(code: MobileCommerceError['code']) {
    super(code);
    this.name = 'MobileCommerceError';
    this.code = code;
  }
}

export type MobileOffering = {
  readonly productId: CloudProductId;
  readonly priceString: string;
  readonly packageIdentifier?: string;
};

export interface PurchaseAdapter {
  readonly configure: (accountId: string) => Promise<void>;
  readonly getOfferings: () => Promise<readonly MobileOffering[]>;
  readonly purchase: (productId: CloudProductId) => Promise<void>;
  readonly restore: () => Promise<void>;
}

const knownProductIds = new Set(Object.values(CLOUD_PRODUCT_IDS));

function isCancellation(error: unknown): boolean {
  if (!(typeof error === 'object' && error !== null)) return false;
  const candidate = error as Record<string, unknown>;
  return candidate.userCancelled === true || candidate.code === 'PURCHASE_CANCELLED';
}

export type NativePurchaseAdapterOptions = {
  readonly apiKey?: string;
};

/**
 * RevenueCat is deliberately imported and configured only after the person has signed in and
 * opened a cloud purchase surface. Local launch and local laboratory mode never initialize it.
 */
export function createNativePurchaseAdapter(
  options: NativePurchaseAdapterOptions = {},
): PurchaseAdapter {
  const apiKey = (options.apiKey ?? process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY)?.trim();
  let sdk: typeof Purchases | null = null;
  let configuredAccountId: string | null = null;
  const packages = new Map<
    string,
    { readonly product: unknown; readonly packageIdentifier: string }
  >();

  async function loadSdk() {
    if (sdk !== null) return sdk;
    if (apiKey === undefined || apiKey.length === 0)
      throw new MobileCommerceError('store_unavailable');
    try {
      sdk = (await import('react-native-purchases')).default;
      return sdk;
    } catch {
      throw new MobileCommerceError('store_unavailable');
    }
  }

  return {
    async configure(accountId) {
      const purchases = await loadSdk();
      if (configuredAccountId === accountId) return;
      try {
        if (configuredAccountId === null) {
          purchases.configure({ apiKey, appUserID: accountId } as Parameters<
            typeof purchases.configure
          >[0]);
        } else {
          await purchases.logIn(accountId);
        }
        configuredAccountId = accountId;
      } catch {
        throw new MobileCommerceError('store_unavailable');
      }
    },

    async getOfferings() {
      const purchases = await loadSdk();
      try {
        const offerings = await purchases.getOfferings();
        const available = offerings.current?.availablePackages ?? [];
        packages.clear();
        return available.flatMap((item) => {
          const productId = item.product.identifier;
          if (!knownProductIds.has(productId as CloudProductId)) return [];
          packages.set(productId, { product: item.product, packageIdentifier: item.identifier });
          return [
            {
              productId: productId as CloudProductId,
              priceString: item.product.priceString,
              packageIdentifier: item.identifier,
            },
          ];
        });
      } catch {
        throw new MobileCommerceError('store_unavailable');
      }
    },

    async purchase(productId) {
      const purchases = await loadSdk();
      const selected = packages.get(productId);
      if (selected === undefined) throw new MobileCommerceError('store_unavailable');
      try {
        await purchases.purchaseStoreProduct(
          selected.product as Parameters<typeof purchases.purchaseStoreProduct>[0],
        );
      } catch (error) {
        if (isCancellation(error)) throw new MobileCommerceError('purchase_cancelled');
        throw new MobileCommerceError('purchase_failed');
      }
    },

    async restore() {
      const purchases = await loadSdk();
      try {
        await purchases.restorePurchases();
      } catch (error) {
        if (isCancellation(error)) throw new MobileCommerceError('purchase_cancelled');
        throw new MobileCommerceError('purchase_failed');
      }
    },
  };
}

export type FakePurchaseAdapterOptions = {
  readonly offerings?: readonly MobileOffering[];
  readonly purchaseError?: MobileCommerceError['code'] | null;
};

/** Deterministic adapter for UI and service tests; it never loads native StoreKit. */
export function createFakePurchaseAdapter(
  options: FakePurchaseAdapterOptions = {},
): PurchaseAdapter & {
  readonly purchased: CloudProductId[];
  readonly configuredAccountIds: string[];
} {
  const purchased: CloudProductId[] = [];
  const configuredAccountIds: string[] = [];
  const offerings =
    options.offerings ??
    CLOUD_PLAN_OFFERS.flatMap((offer) => {
      const values: MobileOffering[] = [{ productId: offer.productId, priceString: offer.price }];
      if ('annualProductId' in offer)
        values.push({ productId: offer.annualProductId, priceString: offer.annualPrice });
      return values;
    });
  return {
    purchased,
    configuredAccountIds,
    async configure(accountId) {
      configuredAccountIds.push(accountId);
    },
    async getOfferings() {
      return offerings;
    },
    async purchase(productId) {
      if (options.purchaseError !== undefined && options.purchaseError !== null) {
        throw new MobileCommerceError(options.purchaseError);
      }
      purchased.push(productId);
    },
    async restore() {},
  };
}
