import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  APPLE_EXCHANGE_PATH,
  CLOUD_ALLOWANCES_PATH,
  CLOUD_ALLOWANCES_RECONCILE_PATH,
  CONTRACT_VERSION,
  REVENUECAT_WEBHOOK_PATH,
  type AccountDeletionResponse,
  type AccountDeletionRequest,
  type AccountExportResponse,
  type ApiErrorResponse,
  type AppleExchangeRequest,
  type HealthResponse,
  type RefreshSessionRequest,
  type SessionResponse,
  type SignOutResponse,
} from '@alyte/contracts';
import {
  createProductionAppleIdentityVerifier,
  UnavailableAppleIdentityVerifier,
  type AppleIdentityVerifier,
} from './apple-verifier.js';
import { AuthFailure, AuthService, type AuthLogger, type Clock } from './auth.js';
import { AccountDatabase } from './database.js';
import { CommerceFailure, CommerceService, cloudMaxEnabledFromEnvironment } from './commerce.js';
import { createRevenueCatAuthority, type RevenueCatAuthority } from './revenuecat.js';
import {
  DEFAULT_LOCAL_RUNTIME_PATH,
  loadSessionHashSecret,
  validateRuntimePath,
} from './runtime.js';

export interface ServerOptions {
  readonly database?: AccountDatabase;
  readonly databasePath?: string;
  readonly runtimePath?: string;
  readonly appleVerifier?: AppleIdentityVerifier;
  readonly clock?: Clock;
  readonly hashSecret?: string | Uint8Array;
  readonly accessLifetimeSeconds?: number;
  readonly refreshLifetimeSeconds?: number;
  readonly authLogger?: AuthLogger;
  readonly cleanupIntervalMs?: number;
  readonly revenueCatAuthority?: RevenueCatAuthority;
  readonly revenueCatWebhookSecret?: string;
  readonly cloudMaxEnabled?: boolean;
}

function bodyObject(request: FastifyRequest): Record<string, unknown> {
  if (typeof request.body !== 'object' || request.body === null || Array.isArray(request.body)) {
    return {};
  }
  return request.body as Record<string, unknown>;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string') {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1];
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  if (typeof value === 'string') {
    return value;
  }
  const body = bodyObject(request) as Partial<AccountDeletionRequest>;
  return body.idempotencyKey;
}

function errorResponse(code: string, message: string): ApiErrorResponse {
  return { error: { code, message } };
}

export function createServer(options: ServerOptions = {}): FastifyInstance {
  const production = process.env.NODE_ENV === 'production';
  const configuredRuntimePath = options.runtimePath ?? process.env.ALYTE_RUNTIME_PATH;
  if (production && configuredRuntimePath === undefined) {
    throw new Error('ALYTE_RUNTIME_PATH is required in production');
  }
  const runtimePath = validateRuntimePath(
    configuredRuntimePath ??
      (options.databasePath !== undefined && options.databasePath !== ':memory:'
        ? dirname(options.databasePath)
        : DEFAULT_LOCAL_RUNTIME_PATH),
    production,
  );
  const ownsDatabase = options.database === undefined;
  const databasePath = options.databasePath ?? join(runtimePath, 'alyte.sqlite');
  if (ownsDatabase && databasePath !== ':memory:') {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const database = options.database ?? new AccountDatabase({ filename: databasePath });
  let appleVerifier = options.appleVerifier;
  if (appleVerifier === undefined) {
    const hasAppleAudience =
      process.env.APPLE_AUDIENCE !== undefined || process.env.APPLE_BUNDLE_ID !== undefined;
    if (process.env.NODE_ENV === 'production' && !hasAppleAudience) {
      if (ownsDatabase) {
        database.close();
      }
      throw new Error('APPLE_AUDIENCE is required in production');
    }
    appleVerifier = hasAppleAudience
      ? createProductionAppleIdentityVerifier()
      : new UnavailableAppleIdentityVerifier();
  }
  if (
    process.env.NODE_ENV === 'production' &&
    options.hashSecret === undefined &&
    process.env.ALYTE_SESSION_HASH_SECRET === undefined
  ) {
    if (ownsDatabase) {
      database.close();
    }
    throw new Error('ALYTE_SESSION_HASH_SECRET is required in production');
  }
  const secret = loadSessionHashSecret(runtimePath, {
    production,
    configured: options.hashSecret,
  });
  const server = Fastify({
    bodyLimit: 512 * 1024,
    logger: {
      level: 'info',
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers.idempotency-key',
          'req.headers.x-apple-subject',
          'req.body.identityToken',
          'req.body.rawNonce',
          'req.body.refreshToken',
          'req.body.accessToken',
          'req.body.idToken',
          'req.body.idempotencyKey',
          'req.body.appleSubject',
          'req.body.subject',
          'req.body.email',
          'req.body.name',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  // The RevenueCat signature covers the exact incoming bytes. Parse JSON ourselves so the
  // webhook route receives those bytes while ordinary API routes retain their object body shape.
  server.removeContentTypeParser('application/json');
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const bytes = body as Buffer;
    if (request.url.split('?')[0] === REVENUECAT_WEBHOOK_PATH) {
      done(null, bytes);
      return;
    }
    try {
      done(null, JSON.parse(bytes.toString('utf8')) as unknown);
    } catch {
      done(new Error('invalid_json'));
    }
  });
  const authLogger: AuthLogger = options.authLogger ?? {
    info(event, attributes) {
      server.log.info({ event, outcome: attributes.outcome }, 'auth operation');
    },
    warn(event, attributes) {
      server.log.warn({ event, outcome: attributes.outcome }, 'auth operation rejected');
    },
  };
  const auth = new AuthService({
    database,
    appleVerifier,
    clock: options.clock,
    hashSecret: secret,
    accessLifetimeSeconds: options.accessLifetimeSeconds,
    refreshLifetimeSeconds: options.refreshLifetimeSeconds,
    logger: authLogger,
  });
  const revenueCatApiKey = process.env.REVENUECAT_SECRET_API_KEY;
  const revenueCatWebhookSecret =
    options.revenueCatWebhookSecret ?? process.env.REVENUECAT_WEBHOOK_SECRET;
  const commerce = new CommerceService({
    database,
    authority:
      options.revenueCatAuthority ??
      createRevenueCatAuthority(revenueCatApiKey ? { apiKey: revenueCatApiKey } : {}),
    cloudMaxEnabled: options.cloudMaxEnabled ?? cloudMaxEnabledFromEnvironment(),
    ...(revenueCatWebhookSecret === undefined ? {} : { webhookSecret: revenueCatWebhookSecret }),
  });
  database.cleanupExpired(options.clock?.now() ?? new Date());
  const cleanupInterval = setInterval(
    () => database.cleanupExpired(options.clock?.now() ?? new Date()),
    options.cleanupIntervalMs ?? 15 * 60 * 1_000,
  );
  cleanupInterval.unref();

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthFailure) {
      server.log.warn({ event: 'api.request_rejected', outcome: error.code }, 'request rejected');
      void reply.status(error.statusCode).send(errorResponse(error.code, error.code));
      return;
    }
    if (error instanceof CommerceFailure) {
      server.log.warn({ event: 'api.request_rejected', outcome: error.code }, 'request rejected');
      void reply.status(error.statusCode).send(errorResponse(error.code, error.code));
      return;
    }
    server.log.error({ event: 'api.request_failed', outcome: 'internal_error' }, 'request failed');
    void reply.status(500).send(errorResponse('internal_error', 'internal_error'));
  });

  server.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    contractVersion: CONTRACT_VERSION,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'local',
  }));

  const exchange = async (request: FastifyRequest): Promise<SessionResponse> => {
    const body = bodyObject(request) as Partial<AppleExchangeRequest>;
    return auth.exchangeApple(
      body.identityToken,
      body.rawNonce,
      body.consentPolicyVersion,
      idempotencyKey(request),
    );
  };
  // Apple nonce binding is a versioned protocol change. Keep the former routes fail-closed so an
  // older client cannot silently obtain a session from a server that requires nonce verification.
  const unsupportedAppleExchange = async (): Promise<never> => {
    throw new AuthFailure(426, 'auth_contract_version_unsupported');
  };
  server.post('/v1/auth/apple', unsupportedAppleExchange);
  server.post('/v1/auth/apple/exchange', unsupportedAppleExchange);
  server.post(APPLE_EXCHANGE_PATH, exchange);

  server.post('/v1/auth/refresh', async (request): Promise<SessionResponse> => {
    const body = bodyObject(request) as Partial<RefreshSessionRequest>;
    return auth.refresh(body.refreshToken, idempotencyKey(request));
  });

  const signOut = async (request: FastifyRequest): Promise<SignOutResponse> =>
    auth.signOut(bearerToken(request), idempotencyKey(request));
  server.post('/v1/auth/sign-out', signOut);

  server.get('/v1/account/export', async (request): Promise<AccountExportResponse> =>
    auth.exportAccount(bearerToken(request)),
  );

  server.delete('/v1/account', async (request): Promise<AccountDeletionResponse> =>
    auth.deleteAccount(bearerToken(request), idempotencyKey(request)),
  );

  server.get(CLOUD_ALLOWANCES_PATH, async (request) => {
    const authenticated = auth.authenticateAccess(bearerToken(request));
    return commerce.getAllowanceSummary(authenticated.accountId);
  });

  server.post(CLOUD_ALLOWANCES_RECONCILE_PATH, async (request) => {
    const authenticated = auth.authenticateAccess(bearerToken(request));
    return commerce.reconcile(authenticated.accountId);
  });

  server.post(REVENUECAT_WEBHOOK_PATH, async (request) => {
    const signature = request.headers['x-revenuecat-webhook-signature'];
    const body = Buffer.isBuffer(request.body)
      ? request.body
      : Buffer.from(JSON.stringify(request.body ?? {}), 'utf8');
    return commerce.handleRevenueCatWebhook(
      body,
      typeof signature === 'string' ? signature : undefined,
    );
  });

  server.addHook('onClose', async () => {
    clearInterval(cleanupInterval);
    if (ownsDatabase) {
      database.close();
    }
  });
  return server;
}
