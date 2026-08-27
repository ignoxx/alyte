import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_PRODUCT_IDS } from '@alyte/contracts';
import { AccountDatabase } from './database.js';
import { CommerceFailure, CommerceService } from './commerce.js';
import type { RevenueCatAuthority, RevenueCatCustomerSnapshot } from './revenuecat.js';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const SECRET = 'webhook-secret';
const ACCOUNT = 'alyte-account-1';
type TestClock = { current: Date };

class FakeAuthority implements RevenueCatAuthority {
  snapshot: RevenueCatCustomerSnapshot = { subscriptions: [], nonSubscriptions: [] };

  async getCustomer(): Promise<RevenueCatCustomerSnapshot> {
    return this.snapshot;
  }
}

function makeService(authority?: RevenueCatAuthority, clock: TestClock = { current: NOW }) {
  const database = new AccountDatabase({ filename: ':memory:' });
  database.createAccountForAppleSubject('subject-1', ACCOUNT, NOW.toISOString());
  return {
    database,
    service: new CommerceService({
      database,
      ...(authority === undefined ? {} : { authority }),
      webhookSecret: SECRET,
      now: () => new Date(clock.current),
      idFactory: (() => {
        let next = 0;
        return () => `entry-${++next}`;
      })(),
    }),
  };
}

function signed(body: string): string {
  const timestamp = Math.floor(NOW.getTime() / 1_000);
  const digest = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function starterEvent(transactionId = 'starter-transaction', id = `event-${transactionId}`) {
  return JSON.stringify({
    event: {
      id,
      type: 'NON_RENEWING_PURCHASE',
      app_user_id: ACCOUNT,
      product_id: CLOUD_PRODUCT_IDS.starterPack,
      transaction_id: transactionId,
      purchase_date: NOW.toISOString(),
    },
  });
}

function subscriptionEvent({
  id,
  type = 'INITIAL_PURCHASE',
  transactionId,
  productId = CLOUD_PRODUCT_IDS.cloudPlusMonthly,
  newProductId,
  periodEnd = '2026-09-27T12:00:00.000Z',
}: {
  id: string;
  type?: string;
  transactionId: string;
  productId?: string;
  newProductId?: string;
  periodEnd?: string;
}) {
  return JSON.stringify({
    event: {
      id,
      type,
      app_user_id: ACCOUNT,
      product_id: productId,
      ...(newProductId === undefined ? {} : { new_product_id: newProductId }),
      transaction_id: transactionId,
      purchased_at_ms: NOW.getTime(),
      expiration_at_ms: Date.parse(periodEnd),
    },
  });
}

describe('cloud commerce allowance invariants', () => {
  it('grants Starter once, rejects duplicate webhook work, and keeps separate balances', () => {
    const { service } = makeService();
    const body = starterEvent();
    assert.deepEqual(service.handleRevenueCatWebhook(Buffer.from(body), signed(body)), {
      accepted: true,
      processed: true,
    });
    assert.deepEqual(service.handleRevenueCatWebhook(Buffer.from(body), signed(body)), {
      accepted: true,
      processed: true,
    });
    const summary = service.getAllowanceSummary(ACCOUNT);
    assert.equal(summary.allowances.find((item) => item.kind === 'snap')?.included, 5);
    assert.equal(summary.allowances.find((item) => item.kind === 'report')?.included, 1);
  });

  it('reserves, consumes, releases, and retries each request exactly once', () => {
    const { service } = makeService();
    const body = starterEvent();
    service.handleRevenueCatWebhook(Buffer.from(body), signed(body));

    service.reserve(ACCOUNT, 'snap', 'request-1');
    service.reserve(ACCOUNT, 'snap', 'request-1');
    assert.equal(service.getAllowanceSummary(ACCOUNT).allowances[0]?.reserved, 1);
    service.consume('request-1');
    service.consume('request-1');
    assert.equal(service.getAllowanceSummary(ACCOUNT).allowances[0]?.consumed, 1);

    service.reserve(ACCOUNT, 'snap', 'request-2');
    service.release('request-2');
    service.release('request-2');
    const snapshot = service.getAllowanceSummary(ACCOUNT).allowances[0];
    assert.equal(snapshot?.consumed, 1);
    assert.equal(snapshot?.reserved, 0);
  });

  it('reports warning thresholds without rollover anxiety', () => {
    const { service } = makeService();
    const body = starterEvent();
    service.handleRevenueCatWebhook(Buffer.from(body), signed(body));
    for (let index = 0; index < 4; index += 1) {
      service.reserve(ACCOUNT, 'snap', `request-${index}`);
      service.consume(`request-${index}`);
    }
    const nearLimit = service
      .getAllowanceSummary(ACCOUNT)
      .allowances.find((item) => item.kind === 'snap');
    assert.equal(nearLimit?.warning, 'near-limit');
    service.reserve(ACCOUNT, 'snap', 'request-final');
    assert.equal(
      service.getAllowanceSummary(ACCOUNT).allowances.find((item) => item.kind === 'snap')?.warning,
      'exhausted',
    );
    assert.throws(
      () => service.reserve(ACCOUNT, 'snap', 'request-over'),
      (error: unknown) => {
        return error instanceof CommerceFailure && error.code === 'allowance_exhausted';
      },
    );
  });

  it('resets subscription units at the RevenueCat period boundary without carry-over', async () => {
    const authority = new FakeAuthority();
    authority.snapshot = {
      subscriptions: [
        {
          productId: CLOUD_PRODUCT_IDS.cloudPlusMonthly,
          transactionId: 'period-1',
          purchasedAt: NOW.toISOString(),
          periodStart: NOW.toISOString(),
          periodEnd: '2026-08-31T12:00:00.000Z',
          willRenew: true,
          managementUrl: 'https://apps.apple.com/account/subscriptions',
        },
      ],
      nonSubscriptions: [],
    };
    const clock: TestClock = { current: NOW };
    const { service } = makeService(authority, clock);
    await service.reconcile(ACCOUNT);
    service.reserve(ACCOUNT, 'snap', 'period-request');
    service.consume('period-request');
    clock.current = new Date('2026-09-01T12:00:00.000Z');
    authority.snapshot = {
      subscriptions: [
        {
          ...authority.snapshot.subscriptions[0]!,
          transactionId: 'period-2',
          periodStart: '2026-09-01T12:00:00.000Z',
          periodEnd: '2026-09-30T12:00:00.000Z',
        },
      ],
      nonSubscriptions: [],
    };
    await service.reconcile(ACCOUNT);
    const summary = service
      .getAllowanceSummary(ACCOUNT)
      .allowances.find((item) => item.kind === 'snap');
    assert.equal(summary?.included, 500);
    assert.equal(summary?.consumed, 0);
    assert.equal(summary?.resetAt, '2026-09-30T12:00:00.000Z');
  });

  it('splits an annual subscription into monthly allowance buckets', async () => {
    const authority = new FakeAuthority();
    authority.snapshot = {
      subscriptions: [
        {
          productId: CLOUD_PRODUCT_IDS.cloudPlusAnnual,
          transactionId: 'annual-1',
          purchasedAt: NOW.toISOString(),
          periodStart: NOW.toISOString(),
          periodEnd: '2027-08-27T12:00:00.000Z',
          willRenew: true,
          managementUrl: null,
        },
      ],
      nonSubscriptions: [],
    };
    const clock: TestClock = { current: NOW };
    const { service } = makeService(authority, clock);
    await service.reconcile(ACCOUNT);
    let summary = service
      .getAllowanceSummary(ACCOUNT)
      .allowances.find((item) => item.kind === 'snap');
    assert.equal(summary?.included, 500);
    assert.equal(summary?.resetAt, '2026-09-27T12:00:00.000Z');

    clock.current = new Date('2026-09-27T12:00:00.000Z');
    summary = service.getAllowanceSummary(ACCOUNT).allowances.find((item) => item.kind === 'snap');
    assert.equal(summary?.included, 500);
    assert.equal(summary?.consumed, 0);
    assert.equal(summary?.resetAt, '2026-10-27T12:00:00.000Z');
  });

  it('moves a reservation to the subscription grant after Starter is exhausted', () => {
    const authority = new FakeAuthority();
    const clock: TestClock = { current: NOW };
    const { database, service } = makeService(authority, clock);
    const starter = starterEvent();
    service.handleRevenueCatWebhook(Buffer.from(starter), signed(starter));
    for (let index = 0; index < 5; index += 1) {
      service.reserve(ACCOUNT, 'snap', `starter-${index}`);
      service.consume(`starter-${index}`);
    }
    const subscription = subscriptionEvent({
      id: 'subscription-1',
      transactionId: 'subscription-1',
    });
    service.handleRevenueCatWebhook(Buffer.from(subscription), signed(subscription));
    service.reserve(ACCOUNT, 'snap', 'subscription-request');
    const reservation = database.findAllowanceReservation('subscription-request');
    assert.equal(reservation?.grant_period_start, NOW.toISOString());
    assert.notEqual(reservation?.grant_source_id, 'grant:starter-transaction:snap');
  });

  it('preserves cancelled access through its period and removes it on refund', () => {
    const { service } = makeService();
    const purchase = subscriptionEvent({ id: 'cancel-purchase', transactionId: 'cancel-1' });
    service.handleRevenueCatWebhook(Buffer.from(purchase), signed(purchase));
    const cancellation = subscriptionEvent({
      id: 'cancel-event',
      type: 'CANCELLATION',
      transactionId: 'cancel-1',
    });
    service.handleRevenueCatWebhook(Buffer.from(cancellation), signed(cancellation));
    const duringPeriod = service.getAllowanceSummary(ACCOUNT);
    assert.equal(duringPeriod.entitlements[0]?.willRenew, false);
    assert.equal(duringPeriod.allowances.find((item) => item.kind === 'snap')?.included, 500);

    const refund = subscriptionEvent({
      id: 'refund-event',
      type: 'REFUND',
      transactionId: 'cancel-1',
    });
    service.handleRevenueCatWebhook(Buffer.from(refund), signed(refund));
    assert.equal(
      service.getAllowanceSummary(ACCOUNT).allowances.find((item) => item.kind === 'snap')
        ?.included,
      0,
    );
  });

  it('reconciles a product change by expiring the previous plan', () => {
    const { service } = makeService();
    const initial = subscriptionEvent({ id: 'change-initial', transactionId: 'change-1' });
    service.handleRevenueCatWebhook(Buffer.from(initial), signed(initial));
    const change = subscriptionEvent({
      id: 'change-event',
      type: 'PRODUCT_CHANGE',
      productId: CLOUD_PRODUCT_IDS.cloudPlusMonthly,
      newProductId: CLOUD_PRODUCT_IDS.cloudMaxMonthly,
      transactionId: 'change-2',
    });
    service.handleRevenueCatWebhook(Buffer.from(change), signed(change));
    const summary = service.getAllowanceSummary(ACCOUNT);
    assert.equal(
      summary.entitlements.find((item) => item.planId === 'cloud_plus')?.status,
      'expired',
    );
    assert.equal(
      summary.entitlements.find((item) => item.planId === 'cloud_max')?.status,
      'active',
    );
  });

  it('does not recreate commerce state from a webhook after account deletion', () => {
    const { database, service } = makeService();
    database.deleteAccountData(ACCOUNT);
    const body = starterEvent('deleted-transaction');
    assert.deepEqual(service.handleRevenueCatWebhook(Buffer.from(body), signed(body)), {
      accepted: true,
      processed: false,
    });
    assert.throws(
      () => service.getAllowanceSummary(ACCOUNT),
      (error: unknown) => {
        return error instanceof CommerceFailure && error.code === 'account_not_found';
      },
    );
  });

  it('allows a deleted account purchase claim to be restored once, never shared live', () => {
    const { database, service } = makeService();
    database.createAccountForAppleSubject('subject-2', 'alyte-account-2', NOW.toISOString());
    const body = starterEvent('shared-transaction', 'shared-live');
    assert.equal(service.handleRevenueCatWebhook(Buffer.from(body), signed(body)).processed, true);
    const otherBody = body
      .replaceAll(`"app_user_id":"${ACCOUNT}"`, '"app_user_id":"alyte-account-2"')
      .replace('shared-live', 'shared-live-other');
    assert.equal(
      service.handleRevenueCatWebhook(Buffer.from(otherBody), signed(otherBody)).processed,
      true,
    );
    assert.equal(
      service.getAllowanceSummary('alyte-account-2').allowances.find((item) => item.kind === 'snap')
        ?.included,
      0,
    );
    database.deleteAccountData(ACCOUNT);
    const restoredBody = body
      .replaceAll(`"app_user_id":"${ACCOUNT}"`, '"app_user_id":"alyte-account-2"')
      .replace('shared-live', 'shared-live-restored');
    assert.equal(
      service.handleRevenueCatWebhook(Buffer.from(restoredBody), signed(restoredBody)).processed,
      true,
    );
    assert.equal(
      service.getAllowanceSummary('alyte-account-2').allowances.find((item) => item.kind === 'snap')
        ?.included,
      5,
    );
  });

  it('reconciles an already-owned Cloud Max even when new purchases are gated', () => {
    const { service } = makeService();
    const body = JSON.stringify({
      event: {
        id: 'max-event',
        type: 'INITIAL_PURCHASE',
        app_user_id: ACCOUNT,
        product_id: CLOUD_PRODUCT_IDS.cloudMaxMonthly,
        transaction_id: 'max-transaction',
        purchase_date: NOW.toISOString(),
        expiration_at_ms: NOW.getTime() + 86_400_000,
      },
    });
    assert.equal(service.handleRevenueCatWebhook(Buffer.from(body), signed(body)).processed, true);
    assert.equal(service.getAllowanceSummary(ACCOUNT).entitlements[0]?.planId, 'cloud_max');
  });

  it('verifies the raw webhook bytes and rejects stale signatures', () => {
    const { service } = makeService();
    const body = starterEvent();
    assert.throws(
      () => service.handleRevenueCatWebhook(Buffer.from(`${body} `), signed(body)),
      (error: unknown) => {
        return error instanceof CommerceFailure && error.code === 'webhook_signature_invalid';
      },
    );
  });
});
