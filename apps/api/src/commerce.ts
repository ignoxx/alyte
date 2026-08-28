import { randomUUID } from 'node:crypto';
import {
  CLOUD_PLAN_OFFERS,
  CLOUD_PRODUCT_IDS,
  type CloudAllowanceKind,
  type CloudAllowanceResponse,
  type CloudAllowanceSummary,
  type CloudAllowanceWarning,
  type CloudEntitlementStatus,
  type CloudProductId,
  type CloudReconcileResponse,
  type RevenueCatWebhookResponse,
} from '@alyte/contracts';
import type {
  AccountDatabase,
  AllowanceLedgerRow,
  CommerceLedgerEntryType,
  CommercePlanId,
  CommercePurchaseRow,
} from './database.js';
import {
  parseRevenueCatWebhookBody,
  RevenueCatFailure,
  type RevenueCatAuthority,
  type RevenueCatCustomerSnapshot,
  UnavailableRevenueCatAuthority,
  verifyRevenueCatSignature,
} from './revenuecat.js';

export class CommerceFailure extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = 'CommerceFailure';
    this.statusCode = statusCode;
    this.code = code;
  }
}

type PlanDefinition = {
  readonly planId: CommercePlanId;
  readonly productId: string;
  readonly snapAllowance: number;
  readonly reportAllowance: number;
  readonly recurring: boolean;
};

const PLAN_DEFINITIONS: readonly PlanDefinition[] = CLOUD_PLAN_OFFERS.flatMap((offer) => {
  const products = [
    offer.productId,
    ...('annualProductId' in offer ? [offer.annualProductId] : []),
  ];
  return products.map((productId) => ({
    planId: offer.planId,
    productId,
    snapAllowance: offer.snapAllowance,
    reportAllowance: offer.reportAllowance,
    recurring: offer.recurring,
  }));
});

const GRANT_KINDS: readonly CloudAllowanceKind[] = ['snap', 'report'];
const GRANT_EVENTS = new Set([
  'INITIAL_PURCHASE',
  'NON_RENEWING_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'UNCANCELLATION',
  'SUBSCRIPTION_EXTENDED',
]);
const END_EVENTS = new Set(['EXPIRATION', 'REFUND']);

export type CommerceServiceOptions = {
  readonly database: AccountDatabase;
  readonly authority?: RevenueCatAuthority;
  readonly webhookSecret?: string;
  readonly now?: () => Date;
  readonly cloudMaxEnabled?: boolean;
  readonly idFactory?: () => string;
};

export type ReservationResult = {
  readonly requestId: string;
  readonly kind: CloudAllowanceKind;
  readonly reserved: boolean;
};

function planForProduct(productId: string): PlanDefinition | undefined {
  return PLAN_DEFINITIONS.find((plan) => plan.productId === productId);
}

function parseDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
  if (/^\d{9,16}$/.test(value)) {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function boundedString(value: unknown, max = 512): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function eventValue(root: Record<string, unknown>): Record<string, unknown> {
  const event = root.event;
  return typeof event === 'object' && event !== null && !Array.isArray(event)
    ? (event as Record<string, unknown>)
    : root;
}

type WebhookEvent = {
  readonly id: string;
  readonly type: string;
  readonly accountId: string;
  readonly productId: string;
  readonly previousProductId: string | null;
  readonly transactionId: string | null;
  readonly purchasedAt: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly willRenew: boolean;
  readonly managementUrl: string | null;
};

function decodeWebhookEvent(root: Record<string, unknown>): WebhookEvent {
  const event = eventValue(root);
  const id = boundedString(event.id, 256);
  const type = boundedString(event.type, 64);
  const accountId = boundedString(event.app_user_id, 256);
  const currentProductId = boundedString(event.product_id, 256);
  const replacementProductId = boundedString(event.new_product_id, 256);
  const productId =
    type === 'PRODUCT_CHANGE' ? (replacementProductId ?? currentProductId) : currentProductId;
  const purchasedAt =
    parseDate(event.purchased_at_ms ?? event.purchase_date ?? event.event_timestamp_ms) ??
    new Date(0).toISOString();
  if (id === null || type === null || accountId === null) {
    throw new CommerceFailure(400, 'webhook_invalid_event');
  }
  if (
    productId === null &&
    (GRANT_EVENTS.has(type) ||
      END_EVENTS.has(type) ||
      type === 'CANCELLATION' ||
      type === 'BILLING_ISSUE')
  ) {
    throw new CommerceFailure(400, 'webhook_invalid_event');
  }
  return {
    id,
    type,
    accountId,
    productId: productId ?? '',
    previousProductId: type === 'PRODUCT_CHANGE' ? currentProductId : null,
    transactionId:
      boundedString(event.transaction_id, 256) ??
      boundedString(event.store_transaction_id, 256) ??
      boundedString(event.original_transaction_id, 256),
    purchasedAt,
    periodStart: parseDate(
      event.purchased_at_ms ?? event.purchase_date ?? event.original_purchase_date,
    ),
    periodEnd: parseDate(event.expiration_at_ms ?? event.expires_date),
    willRenew:
      event.unsubscribe_detected_at === undefined || event.unsubscribe_detected_at === null,
    managementUrl: boundedString(event.management_url, 2_048),
  };
}

function isFuture(date: string | null, now: number): boolean {
  return date === null || Date.parse(date) > now;
}

function activeStatus(status: CloudEntitlementStatus): boolean {
  return status === 'active' || status === 'pending';
}

function warningFor(included: number, remaining: number): CloudAllowanceWarning {
  if (remaining <= 0 || included <= 0) return 'exhausted';
  const used = included - remaining;
  const ratio = used / included;
  if (ratio >= 0.95) return 'critical';
  if (ratio >= 0.8) return 'near-limit';
  return 'normal';
}

function grantSource(
  transactionId: string,
  kind: CloudAllowanceKind,
  periodStart: string | null = null,
): string {
  return periodStart === null
    ? `grant:${transactionId}:${kind}`
    : `grant:${transactionId}:${periodStart}:${kind}`;
}

type GrantAllocation = {
  readonly grant: AllowanceLedgerRow;
  readonly purchase: CommercePurchaseRow;
};

function isWithinGrantPeriod(grant: AllowanceLedgerRow, now: number): boolean {
  if (grant.period_end !== null && !isFuture(grant.period_end, now)) return false;
  return grant.grant_period_start === null || Date.parse(grant.grant_period_start) <= now;
}

function addCalendarMonth(value: Date): Date {
  const year = value.getUTCFullYear();
  const month = value.getUTCMonth();
  const day = value.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month + 1,
      Math.min(day, lastDay),
      value.getUTCHours(),
      value.getUTCMinutes(),
      value.getUTCSeconds(),
      value.getUTCMilliseconds(),
    ),
  );
}

function subscriptionBuckets(
  periodStart: string | null,
  periodEnd: string | null,
): readonly { periodStart: string | null; periodEnd: string | null }[] {
  if (periodStart === null || periodEnd === null) {
    return [{ periodStart, periodEnd }];
  }
  const start = new Date(periodStart);
  const end = new Date(periodEnd);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return [{ periodStart, periodEnd }];
  }
  // RevenueCat's annual product is granted in monthly buckets so a year does not become
  // twelve months of allowance on day one. The period start is the deterministic anchor.
  if (end.getTime() - start.getTime() <= 45 * 24 * 60 * 60 * 1_000) {
    return [{ periodStart, periodEnd }];
  }
  const buckets: { periodStart: string; periodEnd: string }[] = [];
  let cursor = start;
  for (let count = 0; count < 24 && cursor < end; count += 1) {
    const next = addCalendarMonth(cursor);
    const bucketEnd = next < end ? next : end;
    buckets.push({
      periodStart: cursor.toISOString(),
      periodEnd: bucketEnd.toISOString(),
    });
    cursor = bucketEnd;
  }
  return buckets.length > 0 ? buckets : [{ periodStart, periodEnd }];
}

function entryId(idFactory: () => string): string {
  return idFactory();
}

export class CommerceService {
  private readonly database: AccountDatabase;
  private readonly authority: RevenueCatAuthority;
  private readonly webhookSecret: string | undefined;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: CommerceServiceOptions) {
    this.database = options.database;
    this.authority = options.authority ?? new UnavailableRevenueCatAuthority();
    this.webhookSecret = options.webhookSecret;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  getAllowanceSummary(accountId: string): CloudAllowanceResponse {
    this.requireAccount(accountId);
    return this.summary(accountId);
  }

  reserve(accountId: string, kind: CloudAllowanceKind, requestId: string): ReservationResult {
    return this.database.transaction(() => this.reserveInTransaction(accountId, kind, requestId));
  }

  /**
   * Reserve one allowance unit while the caller owns the database transaction. Cloud Request
   * admission uses this seam so request creation and reservation commit or roll back together.
   */
  reserveInTransaction(
    accountId: string,
    kind: CloudAllowanceKind,
    requestId: string,
  ): ReservationResult {
    if (!GRANT_KINDS.includes(kind) || !boundedString(requestId, 256)) {
      throw new CommerceFailure(400, 'allowance_request_invalid');
    }
    this.requireAccount(accountId);
    const existing = this.database.findAllowanceLedgerEntry(accountId, kind, 'reserve', requestId);
    if (existing !== undefined) {
      return { requestId, kind, reserved: true };
    }
    const summary = this.summary(accountId);
    const allowance = summary.allowances.find((item) => item.kind === kind);
    if (allowance === undefined || allowance.remaining < 1) {
      throw new CommerceFailure(409, 'allowance_exhausted');
    }
    const allocation = this.periodForReservation(accountId, kind);
    this.database.addAllowanceLedgerEntry({
      id: entryId(this.idFactory),
      account_id: accountId,
      kind,
      entry_type: 'reserve',
      units: 1,
      source_id: requestId,
      grant_source_id: allocation.grant.source_id,
      grant_period_start: allocation.grant.grant_period_start,
      period_end: allocation.grant.period_end,
      created_at: this.now().toISOString(),
    });
    return { requestId, kind, reserved: true };
  }

  release(requestId: string): void {
    this.database.transaction(() => this.releaseInTransaction(requestId));
  }

  /** Release a reservation while the caller owns the database transaction. */
  releaseInTransaction(requestId: string): void {
    const reservation = this.findReservation(requestId);
    if (reservation === undefined) return;
    if (
      this.database.findAllowanceLedgerEntry(
        reservation.account_id,
        reservation.kind,
        'release',
        requestId,
      ) !== undefined ||
      this.database.findAllowanceLedgerEntry(
        reservation.account_id,
        reservation.kind,
        'consume',
        requestId,
      ) !== undefined
    )
      return;
    this.addLedger(reservation.account_id, reservation.kind, 'release', requestId, reservation);
  }

  consume(requestId: string): void {
    const reservation = this.findReservation(requestId);
    if (reservation === undefined) throw new CommerceFailure(404, 'allowance_reservation_missing');
    this.database.transaction(() => this.consumeInTransaction(requestId));
  }

  /** Consume a reservation while the caller owns the SQLite transaction. */
  consumeInTransaction(requestId: string): void {
    const reservation = this.findReservation(requestId);
    if (reservation === undefined) throw new CommerceFailure(404, 'allowance_reservation_missing');
    if (
      this.database.findAllowanceLedgerEntry(
        reservation.account_id,
        reservation.kind,
        'consume',
        requestId,
      ) !== undefined
    )
      return;
    if (
      this.database.findAllowanceLedgerEntry(
        reservation.account_id,
        reservation.kind,
        'release',
        requestId,
      ) !== undefined
    )
      throw new CommerceFailure(409, 'allowance_reservation_released');
    if (!isFuture(reservation.period_end, this.now().getTime())) {
      this.addLedger(reservation.account_id, reservation.kind, 'release', requestId, reservation);
      throw new CommerceFailure(409, 'allowance_reservation_expired');
    }
    this.addLedger(reservation.account_id, reservation.kind, 'consume', requestId, reservation);
  }

  async reconcile(accountId: string): Promise<CloudReconcileResponse> {
    this.requireAccount(accountId);
    let customer: RevenueCatCustomerSnapshot;
    try {
      customer = await this.authority.getCustomer(accountId);
    } catch (error) {
      if (error instanceof RevenueCatFailure) {
        throw new CommerceFailure(error.statusCode, error.code);
      }
      throw new CommerceFailure(503, 'revenuecat_unavailable');
    }
    this.database.transaction(() => this.applyCustomerSnapshot(accountId, customer));
    return { ...this.summary(accountId), reconciled: true };
  }

  handleRevenueCatWebhook(body: Uint8Array, signature?: string): RevenueCatWebhookResponse {
    if (!verifyRevenueCatSignature(body, signature, this.webhookSecret, this.now().getTime())) {
      throw new CommerceFailure(401, 'webhook_signature_invalid');
    }
    const root = parseRevenueCatWebhookBody(body);
    const event = decodeWebhookEvent(root);
    const existing = this.database.findCommerceWebhookEvent(event.id);
    if (existing !== undefined)
      return { accepted: true, processed: existing.outcome === 'processed' };
    const plan = event.productId === '' ? undefined : planForProduct(event.productId);
    const recognized =
      plan !== undefined &&
      (GRANT_EVENTS.has(event.type) ||
        END_EVENTS.has(event.type) ||
        event.type === 'CANCELLATION' ||
        event.type === 'BILLING_ISSUE');
    return this.database.transaction(() => {
      const receivedAt = this.now().toISOString();
      this.database.recordCommerceWebhookEvent({
        event_id: event.id,
        event_type: event.type,
        received_at: receivedAt,
        processed_at: null,
        outcome:
          recognized && this.database.findAccount(event.accountId) !== undefined
            ? 'processed'
            : 'ignored',
      });
      if (
        !recognized ||
        plan === undefined ||
        this.database.findAccount(event.accountId) === undefined
      ) {
        this.database.updateCommerceWebhookEvent(event.id, receivedAt, 'ignored');
        return { accepted: true, processed: false };
      }
      this.applyEvent(event, plan);
      this.database.updateCommerceWebhookEvent(event.id, receivedAt, 'processed');
      return { accepted: true, processed: true };
    });
  }

  private requireAccount(accountId: string): void {
    if (this.database.findAccount(accountId) === undefined) {
      throw new CommerceFailure(404, 'account_not_found');
    }
  }

  private summary(accountId: string): CloudAllowanceResponse {
    const now = this.now().getTime();
    const entitlements = this.database.listCommerceEntitlements(accountId);
    const purchases = this.database.listCommercePurchases(accountId);
    const ledger = this.database.listAllowanceLedger(accountId);
    const activeEntitlements = new Set(
      entitlements
        .filter((item) => activeStatus(item.status) && isFuture(item.period_end, now))
        .map((item) => `${item.plan_id}:${item.product_id}`),
    );
    const releasedSources = new Set(
      ledger.filter((item) => item.entry_type === 'release').map((item) => item.source_id),
    );
    const validGrants = ledger.filter((item) => {
      if (item.entry_type !== 'grant' || !isWithinGrantPeriod(item, now)) return false;
      if (releasedSources.has(item.source_id)) return false;
      const purchase = purchases.find((candidate) => this.grantBelongsToPurchase(item, candidate));
      return (
        purchase !== undefined &&
        activeEntitlements.has(`${purchase.plan_id}:${purchase.product_id}`)
      );
    });
    const allowances = GRANT_KINDS.map((kind): CloudAllowanceSummary => {
      const grants = validGrants.filter((item) => item.kind === kind);
      const included = grants.reduce((sum, item) => sum + item.units, 0);
      const reservations = ledger.filter(
        (item) =>
          item.kind === kind &&
          item.entry_type === 'reserve' &&
          isWithinGrantPeriod(item, now) &&
          grants.some((grant) => this.entryBelongsToGrant(item, grant)),
      );
      const consumed = ledger.filter(
        (item) =>
          item.kind === kind &&
          item.entry_type === 'consume' &&
          isWithinGrantPeriod(item, now) &&
          grants.some((grant) => this.entryBelongsToGrant(item, grant)),
      );
      const activeReservations = reservations.filter(
        (item) =>
          !releasedSources.has(item.source_id) &&
          !consumed.some((entry) => entry.source_id === item.source_id),
      );
      const used =
        consumed.reduce((sum, item) => sum + item.units, 0) +
        activeReservations.reduce((sum, item) => sum + item.units, 0);
      const resetAt =
        grants
          .map((item) => item.period_end)
          .filter((item): item is string => item !== null)
          .sort()[0] ?? null;
      const remaining = Math.max(0, included - used);
      return {
        kind,
        included,
        consumed: consumed.reduce((sum, item) => sum + item.units, 0),
        reserved: activeReservations.reduce((sum, item) => sum + item.units, 0),
        remaining,
        warning: warningFor(included, remaining),
        resetAt,
      };
    });
    const entitlementSummaries = entitlements.flatMap((item) => {
      const plan = planForProduct(item.product_id);
      if (plan === undefined) return [];
      return [
        {
          planId: item.plan_id,
          productId: plan.productId as CloudProductId,
          status: item.status,
          willRenew: item.will_renew === 1,
          periodStart: item.period_start,
          periodEnd: item.period_end,
        },
      ];
    });
    const managementUrl =
      entitlements.find((item) => item.management_url !== null)?.management_url ?? null;
    return {
      accountId,
      entitlements: entitlementSummaries,
      allowances,
      managementUrl,
      generatedAt: this.now().toISOString(),
    };
  }

  private periodForReservation(accountId: string, kind: CloudAllowanceKind): GrantAllocation {
    const now = this.now().getTime();
    const allocations = this.activeGrantAllocations(accountId, kind);
    const ledger = this.database.listAllowanceLedger(accountId, kind);
    const available = allocations
      .map((allocation) => {
        const used = ledger
          .filter(
            (entry) =>
              (entry.entry_type === 'consume' || entry.entry_type === 'reserve') &&
              this.entryBelongsToGrant(entry, allocation.grant) &&
              isWithinGrantPeriod(entry, now) &&
              (entry.entry_type === 'consume' ||
                (this.database.findAllowanceLedgerEntry(
                  accountId,
                  kind,
                  'release',
                  entry.source_id,
                ) === undefined &&
                  this.database.findAllowanceLedgerEntry(
                    accountId,
                    kind,
                    'consume',
                    entry.source_id,
                  ) === undefined)),
          )
          .reduce((sum, entry) => sum + entry.units, 0);
        return { allocation, remaining: allocation.grant.units - used };
      })
      .filter((item) => item.remaining > 0)
      .sort((left, right) => {
        const leftStarter = left.allocation.purchase.plan_id === 'starter_pack';
        const rightStarter = right.allocation.purchase.plan_id === 'starter_pack';
        if (leftStarter !== rightStarter) return leftStarter ? -1 : 1;
        return (left.allocation.grant.period_end ?? '').localeCompare(
          right.allocation.grant.period_end ?? '',
        );
      });
    const selected = available[0]?.allocation;
    if (selected === undefined) throw new CommerceFailure(409, 'allowance_exhausted');
    return selected;
  }

  private findReservation(requestId: string): AllowanceLedgerRow | undefined {
    return this.database.findAllowanceReservation(requestId);
  }

  private grantBelongsToPurchase(
    grant: AllowanceLedgerRow,
    purchase: CommercePurchaseRow,
  ): boolean {
    const source = grant.grant_source_id ?? grant.source_id;
    return source.startsWith(`grant:${purchase.transaction_id}:`);
  }

  private entryBelongsToGrant(entry: AllowanceLedgerRow, grant: AllowanceLedgerRow): boolean {
    if (entry.grant_source_id !== null) return entry.grant_source_id === grant.source_id;
    return entry.period_end === grant.period_end;
  }

  private activeGrantAllocations(accountId: string, kind: CloudAllowanceKind): GrantAllocation[] {
    const now = this.now().getTime();
    const purchases = this.database.listCommercePurchases(accountId);
    const entitlements = new Set(
      this.database
        .listCommerceEntitlements(accountId)
        .filter((item) => activeStatus(item.status) && isFuture(item.period_end, now))
        .map((item) => `${item.plan_id}:${item.product_id}`),
    );
    const releasedSources = new Set(
      this.database
        .listAllowanceLedger(accountId, kind)
        .filter((item) => item.entry_type === 'release')
        .map((item) => item.source_id),
    );
    return this.database
      .listAllowanceLedger(accountId, kind)
      .filter(
        (grant) =>
          grant.entry_type === 'grant' &&
          isWithinGrantPeriod(grant, now) &&
          !releasedSources.has(grant.source_id),
      )
      .flatMap((grant) => {
        const purchase = purchases.find((item) => this.grantBelongsToPurchase(grant, item));
        if (
          purchase === undefined ||
          !entitlements.has(`${purchase.plan_id}:${purchase.product_id}`)
        )
          return [];
        return [{ grant, purchase }];
      });
  }

  private addLedger(
    accountId: string,
    kind: CloudAllowanceKind,
    entryType: CommerceLedgerEntryType,
    sourceId: string,
    reservation: AllowanceLedgerRow,
  ): void {
    this.database.addAllowanceLedgerEntry({
      id: entryId(this.idFactory),
      account_id: accountId,
      kind,
      entry_type: entryType,
      units: reservation.units,
      source_id: sourceId,
      grant_source_id: reservation.grant_source_id,
      grant_period_start: reservation.grant_period_start,
      period_end: reservation.period_end,
      created_at: this.now().toISOString(),
    });
  }

  private applyCustomerSnapshot(accountId: string, customer: RevenueCatCustomerSnapshot): void {
    const activeProducts: string[] = [];
    for (const purchase of customer.nonSubscriptions) {
      const plan = planForProduct(purchase.productId);
      if (plan === undefined) continue;
      this.applyPurchase(
        accountId,
        plan,
        purchase.transactionId,
        purchase.purchasedAt,
        null,
        null,
        false,
        false,
      );
    }
    for (const subscription of customer.subscriptions) {
      const plan = planForProduct(subscription.productId);
      if (plan === undefined) continue;
      activeProducts.push(subscription.productId);
      this.applyPurchase(
        accountId,
        plan,
        subscription.transactionId,
        subscription.purchasedAt,
        subscription.periodStart,
        subscription.periodEnd,
        true,
        subscription.willRenew,
        subscription.managementUrl,
      );
    }
    this.database.expireCommerceSubscriptions(accountId, activeProducts, this.now().toISOString());
  }

  private applyEvent(event: WebhookEvent, plan: PlanDefinition): void {
    const isEnded = END_EVENTS.has(event.type);
    const isPending = event.type === 'BILLING_ISSUE';
    const status: CloudEntitlementStatus = isEnded
      ? event.type === 'REFUND'
        ? 'revoked'
        : 'expired'
      : isPending
        ? 'pending'
        : 'active';
    if (event.type === 'PRODUCT_CHANGE' && event.previousProductId !== null) {
      const previousPlan = planForProduct(event.previousProductId);
      if (previousPlan !== undefined && previousPlan.productId !== plan.productId) {
        const previousEntitlement = this.database
          .listCommerceEntitlements(event.accountId)
          .find((item) => item.plan_id === previousPlan.planId);
        this.revokeGrant(event.accountId, previousPlan, event.transactionId);
        this.database.upsertCommerceEntitlement({
          account_id: event.accountId,
          plan_id: previousPlan.planId,
          product_id: previousPlan.productId,
          status: 'expired',
          will_renew: 0,
          period_start: previousEntitlement?.period_start ?? event.periodStart,
          period_end: event.periodEnd ?? previousEntitlement?.period_end ?? null,
          management_url: previousEntitlement?.management_url ?? null,
          updated_at: this.now().toISOString(),
        });
      }
    }
    if (isEnded) {
      this.revokeGrant(event.accountId, plan, event.transactionId);
    }
    if (GRANT_EVENTS.has(event.type)) {
      this.applyPurchase(
        event.accountId,
        plan,
        event.transactionId ?? event.id,
        event.purchasedAt,
        event.periodStart,
        event.periodEnd,
        plan.recurring,
        plan.recurring && event.willRenew,
        event.managementUrl,
        status,
      );
      return;
    }
    const existing = this.database
      .listCommerceEntitlements(event.accountId)
      .find((item) => item.plan_id === plan.planId);
    this.database.upsertCommerceEntitlement({
      account_id: event.accountId,
      plan_id: plan.planId,
      product_id: plan.productId,
      status,
      will_renew: event.type === 'CANCELLATION' ? 0 : event.willRenew ? 1 : 0,
      period_start: event.periodStart ?? existing?.period_start ?? null,
      period_end: event.periodEnd ?? existing?.period_end ?? null,
      management_url: event.managementUrl ?? existing?.management_url ?? null,
      updated_at: this.now().toISOString(),
    });
  }

  private revokeGrant(accountId: string, plan: PlanDefinition, transactionId: string | null): void {
    if (transactionId === null) return;
    const purchases = this.database.listCommercePurchases(accountId);
    for (const kind of GRANT_KINDS) {
      const grants = this.database
        .listAllowanceLedger(accountId, kind)
        .filter(
          (item) =>
            item.entry_type === 'grant' &&
            (item.grant_source_id ?? item.source_id).startsWith(`grant:${transactionId}:`),
        );
      const purchase = purchases.find((item) => item.transaction_id === transactionId);
      for (const grant of grants) {
        this.database.addAllowanceLedgerEntry({
          id: entryId(this.idFactory),
          account_id: accountId,
          kind,
          entry_type: 'release',
          units: grant.units,
          source_id: grant.source_id,
          grant_source_id: grant.source_id,
          grant_period_start: grant.grant_period_start,
          period_end: grant.period_end ?? purchase?.period_end ?? null,
          created_at: this.now().toISOString(),
        });
      }
    }
  }

  private applyPurchase(
    accountId: string,
    plan: PlanDefinition,
    transactionId: string,
    purchasedAt: string,
    periodStart: string | null,
    periodEnd: string | null,
    subscription: boolean,
    willRenew = true,
    managementUrl: string | null = null,
    status: CloudEntitlementStatus = 'active',
  ): void {
    const claimed = this.database.claimCommercePurchase(
      accountId,
      transactionId,
      plan.productId,
      this.now().toISOString(),
    );
    if (claimed) {
      const purchase: CommercePurchaseRow = {
        account_id: accountId,
        transaction_id: transactionId,
        product_id: plan.productId,
        plan_id: plan.planId,
        purchase_type: subscription ? 'subscription' : 'starter',
        purchased_at: purchasedAt,
        period_start: periodStart,
        period_end: periodEnd,
        created_at: this.now().toISOString(),
      };
      this.database.recordCommercePurchase(purchase);
      for (const bucket of subscription
        ? subscriptionBuckets(periodStart, periodEnd)
        : [{ periodStart: null, periodEnd: null }]) {
        for (const kind of GRANT_KINDS) {
          this.database.addAllowanceLedgerEntry({
            id: entryId(this.idFactory),
            account_id: accountId,
            kind,
            entry_type: 'grant',
            units: kind === 'snap' ? plan.snapAllowance : plan.reportAllowance,
            source_id: grantSource(transactionId, kind, bucket.periodStart),
            grant_source_id: grantSource(transactionId, kind, bucket.periodStart),
            grant_period_start: bucket.periodStart,
            period_end: bucket.periodEnd,
            created_at: this.now().toISOString(),
          });
        }
      }
    }
    this.database.upsertCommerceEntitlement({
      account_id: accountId,
      plan_id: plan.planId,
      product_id: plan.productId,
      status: periodEnd !== null && !isFuture(periodEnd, this.now().getTime()) ? 'expired' : status,
      will_renew: willRenew ? 1 : 0,
      period_start: periodStart,
      period_end: periodEnd,
      management_url: managementUrl,
      updated_at: this.now().toISOString(),
    });
  }
}

export function cloudMaxEnabledFromEnvironment(): boolean {
  return process.env.ALYTE_ENABLE_CLOUD_MAX === 'true';
}

export { CLOUD_PRODUCT_IDS };
