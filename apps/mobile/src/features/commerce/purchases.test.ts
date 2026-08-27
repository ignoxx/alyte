import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_PRODUCT_IDS } from '@alyte/contracts';
import { createFakePurchaseAdapter } from './purchases';

describe('purchase adapter boundary', () => {
  it('provides deterministic local fixtures without configuring StoreKit', async () => {
    const adapter = createFakePurchaseAdapter();
    await adapter.configure('opaque-account-id');
    const offerings = await adapter.getOfferings();
    assert.equal(
      offerings.some((item) => item.productId === CLOUD_PRODUCT_IDS.starterPack),
      true,
    );
    await adapter.purchase(CLOUD_PRODUCT_IDS.starterPack);
    assert.deepEqual(adapter.purchased, [CLOUD_PRODUCT_IDS.starterPack]);
    assert.deepEqual(adapter.configuredAccountIds, ['opaque-account-id']);
  });
});
