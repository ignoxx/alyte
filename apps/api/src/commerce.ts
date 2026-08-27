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
import {
  AccountDatabase,
  type AllowanceLedgerRow,
  type CommerceEntitlementRow,
  type CommerceLedgerEntryType,
  type CommercePlanId,
  type CommercePurchaseRow,
} from './database.js';
import {
  parseRevenueCatWebhookBody,
  RevenueCatFailure,
  type RevenueCatAuthority,
  type RevenueCatCustomerSnapshot,
  type RevenueCatPurchaseSnapshot,
  type RevenueCatSubscriptionSnapshot,
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
  const productId = boundedString(event.product_id, 256);
  const purchasedAt =
    parseDate(event.purchase_date ?? event.event_timestamp_ms) ?? new Date(0).toISOString();
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
    transactionId:
      boundedString(event.transaction_id, 256) ??
      boundedString(event.store_transaction_id, 256) ??
      boundedString(event.original_transaction_id, 256),
    purchasedAt,
    periodStart: parseDate(event.purchase_date ?? event.original_purchase_date),
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

function grantSource(transactionId: string, kind: CloudAllowanceKind): string {
  return `grant:${transactionId}:${kind}`;
}

function entryId(idFactory: () => string): string {
  return idFactory();
}

export class CommerceService {
  private readonly database: AccountDatabase;
  private readonly authority: RevenueCatAuthority;
  private readonly webhookSecret: string | undefined;
  private readonly now: () => Date;
  private readonly cloudMaxEnabled: boolean;
  private readonly idFactory: () => string;

  constructor(options: CommerceServiceOptions) {
    this.database = options.database;
    this.authority = options.authority ?? new UnavailableRevenueCatAuthority();
    this.webhookSecret = options.webhookSecret;
    this.now = options.now ?? (() => new Date());
    this.cloudMaxEnabled = options.cloudMaxEnabled ?? false;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  getAllowanceSummary(accountId: string): CloudAllowanceResponse {
    this.requireAccount(accountId);
    return this.summary(accountId);
  }

  reserve(accountId: string, kind: CloudAllowanceKind, requestId: string): ReservationResult {
    if (!GRANT_KINDS.includes(kind) || !boundedString(requestId, 256)) {
      throw new CommerceFailure(400, 'allowance_request_invalid');
    }
    this.requireAccount(accountId);
    return this.database.transaction(() => {
      const existing = this.database.findAllowanceLedgerEntry(
        accountId,
        kind,
        'reserve',
        requestId,
      );
      if (existing !== undefined) {
        return { requestId, kind, reserved: true };
      }
      const summary = this.summary(accountId);
      const allowance = summary.allowances.find((item) => item.kind === kind);
      if (allowance === undefined || allowance.remaining < 1) {
        throw new CommerceFailure(409, 'allowance_exhausted');
      }
      const periodEnd = this.periodForReservation(accountId, kind);
      this.database.addAllowanceLedgerEntry({
        id: entryId(this.idFactory),
        account_id: accountId,
        kind,
        entry_type: 'reserve',
        units: 1,
        source_id: requestId,
        period_end: periodEnd,
        created_at: this.now().toISOString(),
      });
      return { requestId, kind, reserved: true };
    });
  }

  release(requestId: string): void {
    const reservation = this.findReservation(requestId);
    if (reservation === undefined) return;
    this.database.transaction(() => {
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
    });
  }

  consume(requestId: string): void {
    const reservation = this.findReservation(requestId);
    if (reservation === undefined) throw new CommerceFailure(404, 'allowance_reservation_missing');
    this.database.transaction(() => {
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
    });
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
      if (this.cloudMaxEnabled || plan.planId !== 'cloud_max') {
        this.applyEvent(event, plan);
        this.database.updateCommerceWebhookEvent(event.id, receivedAt, 'processed');
        return { accepted: true, processed: true };
      }
      this.database.updateCommerceWebhookEvent(event.id, receivedAt, 'ignored');
      return { accepted: true, processed: false };
    });
  }

  private requireAccount(accountId: string): void {
    if (this.database.findAccount(accountId) === undefined) {
      throw new CommerceFailure(404, 'account_not_found');
    }
  }

  private summary(accountId: string): CloudAllowanceResponse {
    const now = this.now().getTime();
    const entitlements = this.database
      .listCommerceEntitlements(accountId)
      .filter((item) => this.cloudMaxEnabled || item.plan_id !== 'cloud_max');
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
      if (item.entry_type !== 'grant' || !isFuture(item.period_end, now)) return false;
      if (releasedSources.has(item.source_id)) return false;
      const transactionId = item.source_id.match(/^grant:(.+):(snap|report)$/)?.[1];
      const purchase = purchases.find((candidate) => candidate.transaction_id === transactionId);
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
          item.kind === kind && item.entry_type === 'reserve' && isFuture(item.period_end, now),
      );
      const consumed = ledger.filter(
        (item) =>
          item.kind === kind && item.entry_type === 'consume' && isFuture(item.period_end, now),
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
        entitlements
          .filter(
            (item) =>
              item.plan_id !== 'starter_pack' &&
              activeStatus(item.status) &&
              isFuture(item.period_end, now) &&
              item.period_end !== null,
          )
          .map((item) => item.period_end as string)
          .sort()
          .at(-1) ?? null;
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

  private periodForReservation(accountId: string, kind: CloudAllowanceKind): string | null {
    const now = this.now().getTime();
    const ledger = this.database.listAllowanceLedger(accountId, kind);
    const purchases = this.database.listCommercePurchases(accountId);
    const starterAvailable = ledger.some((grant) => {
      if (grant.entry_type !== 'grant' || grant.period_end !== null || grant.kind !== kind)
        return false;
      if (
        this.database.findAllowanceLedgerEntry(accountId, kind, 'release', grant.source_id) !==
        undefined
      )
        return false;
      const transactionId = grant.source_id.match(/^grant:(.+):(snap|report)$/)?.[1];
      const purchase = purchases.find((item) => item.transaction_id === transactionId);
      return purchase?.plan_id === 'starter_pack';
    });
    if (starterAvailable) return null;
    return (
      this.database
        .listCommerceEntitlements(accountId)
        .filter(
          (item) =>
            item.plan_id !== 'starter_pack' &&
            activeStatus(item.status) &&
            isFuture(item.period_end, now) &&
            item.period_end !== null,
        )
        .map((item) => item.period_end as string)
        .sort()
        .at(-1) ?? null
    );
  }

  private findReservation(requestId: string): AllowanceLedgerRow | undefined {
    return this.database.findAllowanceReservation(requestId);
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
      period_end: reservation.period_end,
      created_at: this.now().toISOString(),
    });
  }

  private applyCustomerSnapshot(accountId: string, customer: RevenueCatCustomerSnapshot): void {
    const activeProducts: string[] = [];
    for (const purchase of customer.nonSubscriptions) {
      const plan = planForProduct(purchase.productId);
      if (plan === undefined || (plan.planId === 'cloud_max' && !this.cloudMaxEnabled)) continue;
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
      if (plan === undefined || (plan.planId === 'cloud_max' && !this.cloudMaxEnabled)) continue;
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
      will_renew: event.willRenew ? 1 : 0,
      period_start: event.periodStart ?? existing?.period_start ?? null,
      period_end: event.periodEnd ?? existing?.period_end ?? null,
      management_url: event.managementUrl ?? existing?.management_url ?? null,
      updated_at: this.now().toISOString(),
    });
  }

  private revokeGrant(accountId: string, plan: PlanDefinition, transactionId: string | null): void {
    if (transactionId === null) return;
    for (const kind of GRANT_KINDS) {
      const sourceId = grantSource(transactionId, kind);
      const purchase = this.database
        .listCommercePurchases(accountId)
        .find((item) => item.transaction_id === transactionId);
      if (purchase === undefined) continue;
      this.database.addAllowanceLedgerEntry({
        id: entryId(this.idFactory),
        account_id: accountId,
        kind,
        entry_type: 'release',
        units: kind === 'snap' ? plan.snapAllowance : plan.reportAllowance,
        source_id: sourceId,
        period_end: purchase.period_end,
        created_at: this.now().toISOString(),
      });
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
      for (const kind of GRANT_KINDS) {
        this.database.addAllowanceLedgerEntry({
          id: entryId(this.idFactory),
          account_id: accountId,
          kind,
          entry_type: 'grant',
          units: kind === 'snap' ? plan.snapAllowance : plan.reportAllowance,
          source_id: grantSource(transactionId, kind),
          period_end: periodEnd,
          created_at: this.now().toISOString(),
        });
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
