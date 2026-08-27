import { createHmac, timingSafeEqual } from 'node:crypto';

const MAX_REVENUECAT_RESPONSE_BYTES = 512 * 1024;
const MAX_WEBHOOK_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type RevenueCatSubscriptionSnapshot = {
  readonly productId: string;
  readonly transactionId: string;
  readonly purchasedAt: string;
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly willRenew: boolean;
  readonly managementUrl: string | null;
};

export type RevenueCatPurchaseSnapshot = {
  readonly productId: string;
  readonly transactionId: string;
  readonly purchasedAt: string;
};

export type RevenueCatCustomerSnapshot = {
  readonly subscriptions: readonly RevenueCatSubscriptionSnapshot[];
  readonly nonSubscriptions: readonly RevenueCatPurchaseSnapshot[];
};

export interface RevenueCatAuthority {
  getCustomer(accountId: string): Promise<RevenueCatCustomerSnapshot>;
}

export class RevenueCatFailure extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string) {
    super(code);
    this.name = 'RevenueCatFailure';
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class UnavailableRevenueCatAuthority implements RevenueCatAuthority {
  async getCustomer(_accountId: string): Promise<RevenueCatCustomerSnapshot> {
    throw new RevenueCatFailure(503, 'revenuecat_unconfigured');
  }
}

export type RevenueCatAuthorityOptions = {
  readonly apiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max = 512): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function isoDate(value: unknown): string | null {
  const text = boundedText(value, 128);
  return text !== null && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

function dateFromRevenueCat(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
  }
  return isoDate(value);
}

function parseSubscription(
  productId: string,
  value: unknown,
  managementUrl: string | null,
): RevenueCatSubscriptionSnapshot | null {
  if (!isRecord(value)) return null;
  const transactionId =
    boundedText(value.store_transaction_id) ??
    boundedText(value.transaction_id) ??
    boundedText(value.original_purchase_transaction_id);
  const purchasedAt = dateFromRevenueCat(value.purchase_date ?? value.original_purchase_date);
  if (transactionId === null || purchasedAt === null) return null;
  const periodStart = dateFromRevenueCat(value.purchase_date ?? value.original_purchase_date);
  const periodEnd = dateFromRevenueCat(value.expires_date);
  const willRenew =
    value.unsubscribe_detected_at === null || value.unsubscribe_detected_at === undefined;
  return {
    productId,
    transactionId,
    purchasedAt,
    periodStart,
    periodEnd,
    willRenew,
    managementUrl,
  };
}

function parseNonSubscription(productId: string, values: unknown): RevenueCatPurchaseSnapshot[] {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 64).flatMap((value) => {
    if (!isRecord(value)) return [];
    const transactionId = boundedText(value.id) ?? boundedText(value.store_transaction_id);
    const purchasedAt = dateFromRevenueCat(value.purchase_date);
    return transactionId !== null && purchasedAt !== null
      ? [{ productId, transactionId, purchasedAt }]
      : [];
  });
}

function decodeCustomer(value: unknown): RevenueCatCustomerSnapshot {
  if (!isRecord(value) || !isRecord(value.subscriber)) {
    throw new RevenueCatFailure(502, 'revenuecat_invalid_response');
  }
  const subscriber = value.subscriber;
  const managementUrl = boundedText(subscriber.management_url, 2_048);
  const subscriptions = isRecord(subscriber.subscriptions)
    ? Object.entries(subscriber.subscriptions).flatMap(([productId, subscription]) => {
        const parsed = parseSubscription(productId, subscription, managementUrl);
        return parsed === null ? [] : [parsed];
      })
    : [];
  const nonSubscriptions = isRecord(subscriber.non_subscriptions)
    ? Object.entries(subscriber.non_subscriptions).flatMap(([productId, purchases]) =>
        parseNonSubscription(productId, purchases),
      )
    : [];
  return { subscriptions, nonSubscriptions };
}

async function boundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader?.();
  if (reader === undefined) {
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_REVENUECAT_RESPONSE_BYTES) {
      throw new RevenueCatFailure(502, 'revenuecat_response_too_large');
    }
    return body;
  }
  const decoder = new TextDecoder();
  let size = 0;
  let output = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_REVENUECAT_RESPONSE_BYTES) {
      await reader.cancel();
      throw new RevenueCatFailure(502, 'revenuecat_response_too_large');
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
  return output + decoder.decode();
}

export function createRevenueCatAuthority(
  options: RevenueCatAuthorityOptions = {},
): RevenueCatAuthority {
  const apiKey = options.apiKey?.trim();
  if (apiKey === undefined || apiKey.length === 0) return new UnavailableRevenueCatAuthority();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000));
  return {
    async getCustomer(accountId) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response: Response;
        try {
          response = await fetchImpl(
            `https://api.revenuecat.com/v1/subscribers/${encodeURIComponent(accountId)}`,
            {
              headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
              signal: controller.signal,
            },
          );
        } catch {
          throw new RevenueCatFailure(503, 'revenuecat_unavailable');
        }
        if (!response.ok) throw new RevenueCatFailure(503, 'revenuecat_unavailable');
        let payload: unknown;
        try {
          payload = JSON.parse(await boundedResponseText(response)) as unknown;
        } catch (error) {
          if (error instanceof RevenueCatFailure) throw error;
          throw new RevenueCatFailure(502, 'revenuecat_invalid_response');
        }
        return decodeCustomer(payload);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function verifyRevenueCatSignature(
  body: Uint8Array,
  signature: string | undefined,
  secret: string | undefined,
  now = Date.now(),
  toleranceMs = 5 * 60_000,
): boolean {
  if (secret === undefined || secret.length === 0 || signature === undefined) return false;
  const fields = new Map<string, string>();
  for (const part of signature.split(',')) {
    const [key, value] = part.trim().split('=', 2);
    if (key !== undefined && value !== undefined && !fields.has(key)) fields.set(key, value);
  }
  const timestamp = Number(fields.get('t'));
  const digest = fields.get('v1');
  if (!Number.isSafeInteger(timestamp) || digest === undefined || !/^[0-9a-f]{64}$/i.test(digest)) {
    return false;
  }
  if (Math.abs(now - timestamp * 1_000) > toleranceMs) return false;
  const signed = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), Buffer.from(body)]);
  const expected = createHmac('sha256', secret).update(signed).digest();
  const received = Buffer.from(digest, 'hex');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function parseRevenueCatWebhookBody(body: Uint8Array): Record<string, unknown> {
  if (body.byteLength > MAX_WEBHOOK_BYTES) throw new RevenueCatFailure(413, 'webhook_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body).toString('utf8')) as unknown;
  } catch {
    throw new RevenueCatFailure(400, 'webhook_invalid_body');
  }
  if (!isRecord(parsed)) throw new RevenueCatFailure(400, 'webhook_invalid_body');
  return parsed;
}
