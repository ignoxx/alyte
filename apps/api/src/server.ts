import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  CONTRACT_VERSION,
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

export interface ServerOptions {
  readonly database?: AccountDatabase;
  readonly databasePath?: string;
  readonly appleVerifier?: AppleIdentityVerifier;
  readonly clock?: Clock;
  readonly hashSecret?: string | Uint8Array;
  readonly accessLifetimeSeconds?: number;
  readonly refreshLifetimeSeconds?: number;
  readonly authLogger?: AuthLogger;
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
  const ownsDatabase = options.database === undefined;
  const databasePath =
    options.databasePath ??
    join(process.env.ALYTE_RUNTIME_PATH ?? join(tmpdir(), 'alyte-api'), 'alyte.sqlite');
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
  const auth = new AuthService({
    database,
    appleVerifier,
    clock: options.clock,
    hashSecret: options.hashSecret,
    accessLifetimeSeconds: options.accessLifetimeSeconds,
    refreshLifetimeSeconds: options.refreshLifetimeSeconds,
    logger: options.authLogger,
  });
  const server = Fastify({ logger: false });

  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof AuthFailure) {
      void reply.status(error.statusCode).send(errorResponse(error.code, error.code));
      return;
    }
    void reply.status(500).send(errorResponse('internal_error', 'internal_error'));
  });

  server.get('/health', async (): Promise<HealthResponse> => ({
    status: 'ok',
    contractVersion: CONTRACT_VERSION,
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'local',
  }));

  const exchange = async (request: FastifyRequest): Promise<SessionResponse> => {
    const body = bodyObject(request) as Partial<AppleExchangeRequest>;
    return auth.exchangeApple(body.identityToken, body.consentPolicyVersion);
  };
  server.post('/v1/auth/apple', exchange);
  server.post('/v1/auth/apple/exchange', exchange);

  server.post('/v1/auth/refresh', async (request): Promise<SessionResponse> => {
    const body = bodyObject(request) as Partial<RefreshSessionRequest>;
    return auth.refresh(body.refreshToken);
  });

  const signOut = async (request: FastifyRequest): Promise<SignOutResponse> =>
    auth.signOut(bearerToken(request));
  server.post('/v1/auth/sign-out', signOut);

  server.get('/v1/account/export', async (request): Promise<AccountExportResponse> =>
    auth.exportAccount(bearerToken(request)),
  );

  server.delete('/v1/account', async (request): Promise<AccountDeletionResponse> =>
    auth.deleteAccount(bearerToken(request), idempotencyKey(request)),
  );

  server.addHook('onClose', async () => {
    if (ownsDatabase) {
      database.close();
    }
  });
  return server;
}
