import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_PRODUCT_IDS } from '@alyte/contracts';
import { AccountDatabase } from './database.js';
import {
  CommerceFailure,
  CommerceService,
} from './commerce.js';
import type {
  RevenueCatAuthority,
  RevenueCatCustomerSnapshot,
} from './revenuecat.js';

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
  const digest = createHmac('sha256', SECRET)
    .update(`${timestamp}.${body}`)
    .digest('hex');
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
    const nearLimit = service.getAllowanceSummary(ACCOUNT).allowances.find((item) => item.kind === 'snap');
    assert.equal(nearLimit?.warning, 'near-limit');
    service.reserve(ACCOUNT, 'snap', 'request-final');
    assert.equal(service.getAllowanceSummary(ACCOUNT).allowances.find((item) => item.kind === 'snap')?.warning, 'exhausted');
    assert.throws(() => service.reserve(ACCOUNT, 'snap', 'request-over'), (error: unknown) => {
      return error instanceof CommerceFailure && error.code === 'allowance_exhausted';
    });
  });

  it('resets subscription units at the RevenueCat period boundary without carry-over', async () => {
    const authority = new FakeAuthority();
    authority.snapshot = {
      subscriptions: [{
        productId: CLOUD_PRODUCT_IDS.cloudPlusMonthly,
        transactionId: 'period-1',
        purchasedAt: NOW.toISOString(),
        periodStart: NOW.toISOString(),
        periodEnd: '2026-08-31T12:00:00.000Z',
        willRenew: true,
        managementUrl: 'https://apps.apple.com/account/subscriptions',
      }],
      nonSubscriptions: [],
    };
    const clock: TestClock = { current: NOW };
    const { service } = makeService(authority, clock);
    await service.reconcile(ACCOUNT);
    service.reserve(ACCOUNT, 'snap', 'period-request');
    service.consume('period-request');
    clock.current = new Date('2026-09-01T12:00:00.000Z');
    authority.snapshot = {
      subscriptions: [{
        ...authority.snapshot.subscriptions[0]!,
        transactionId: 'period-2',
        periodStart: '2026-09-01T12:00:00.000Z',
        periodEnd: '2026-09-30T12:00:00.000Z',
      }],
      nonSubscriptions: [],
    };
    await service.reconcile(ACCOUNT);
    const summary = service.getAllowanceSummary(ACCOUNT).allowances.find((item) => item.kind === 'snap');
    assert.equal(summary?.included, 500);
    assert.equal(summary?.consumed, 0);
    assert.equal(summary?.resetAt, '2026-09-30T12:00:00.000Z');
  });

  it('does not recreate commerce state from a webhook after account deletion', () => {
    const { database, service } = makeService();
    database.deleteAccountData(ACCOUNT);
    const body = starterEvent('deleted-transaction');
    assert.deepEqual(service.handleRevenueCatWebhook(Buffer.from(body), signed(body)), {
      accepted: true,
      processed: false,
    });
    assert.throws(() => service.getAllowanceSummary(ACCOUNT), (error: unknown) => {
      return error instanceof CommerceFailure && error.code === 'account_not_found';
    });
  });

  it('keeps Cloud Max hidden unless explicitly cost-gated', () => {
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
    assert.equal(service.handleRevenueCatWebhook(Buffer.from(body), signed(body)).processed, false);
    assert.equal(service.getAllowanceSummary(ACCOUNT).entitlements.length, 0);
  });

  it('verifies the raw webhook bytes and rejects stale signatures', () => {
    const { service } = makeService();
    const body = starterEvent();
    assert.throws(() => service.handleRevenueCatWebhook(Buffer.from(`${body} `), signed(body)), (error: unknown) => {
      return error instanceof CommerceFailure && error.code === 'webhook_signature_invalid';
    });
  });
});
