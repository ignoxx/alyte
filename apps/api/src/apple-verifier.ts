import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { isValidAppleRawNonce } from '@alyte/contracts';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

export interface VerifiedAppleIdentity {
  readonly subject: string;
}

export interface AppleIdentityVerifier {
  verify(identityToken: string, rawNonce: string): Promise<VerifiedAppleIdentity>;
}

export class UnavailableAppleIdentityVerifier implements AppleIdentityVerifier {
  async verify(_identityToken: string, _rawNonce: string): Promise<VerifiedAppleIdentity> {
    throw new AppleTokenVerificationError();
  }
}

export class AppleTokenVerificationError extends Error {
  constructor() {
    super('apple_identity_token_invalid');
    this.name = 'AppleTokenVerificationError';
  }
}

export class AppleNonceVerificationError extends AppleTokenVerificationError {
  constructor() {
    super();
    this.name = 'AppleNonceVerificationError';
  }
}

/** Apple receives this lowercase SHA-256 digest; the raw nonce is sent only to Alyte over TLS. */
export function hashAppleNonce(rawNonce: string): string {
  return createHash('sha256').update(rawNonce, 'utf8').digest('hex');
}

export interface ProductionAppleIdentityVerifierOptions {
  readonly audience: string;
  readonly issuer?: string;
  /** Test seam; production uses Apple's remote rotating JWKS. */
  readonly keySet?: JWTVerifyGetKey;
}

/**
 * Verifies Apple's signed identity token against Apple's rotating public keys.
 * The verifier deliberately returns only Apple's stable subject; profile claims
 * are not part of the account boundary.
 */
export class ProductionAppleIdentityVerifier implements AppleIdentityVerifier {
  private readonly keys;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(options: ProductionAppleIdentityVerifierOptions) {
    if (options.audience.trim().length === 0) {
      throw new Error('apple_audience_required');
    }
    this.keys = options.keySet ?? createRemoteJWKSet(new URL(APPLE_JWKS_URL));
    this.issuer = options.issuer ?? APPLE_ISSUER;
    this.audience = options.audience;
  }

  async verify(identityToken: string, rawNonce: string): Promise<VerifiedAppleIdentity> {
    if (identityToken.length === 0 || identityToken.length > 16_384) {
      throw new AppleTokenVerificationError();
    }
    if (!isValidAppleRawNonce(rawNonce)) {
      throw new AppleNonceVerificationError();
    }
    try {
      const { payload } = await jwtVerify(identityToken, this.keys, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
      });
      if (
        typeof payload.sub !== 'string' ||
        payload.sub.length === 0 ||
        payload.sub.length > 512 ||
        typeof payload.exp !== 'number' ||
        payload.exp * 1_000 <= Date.now()
      ) {
        throw new AppleTokenVerificationError();
      }
      const expectedNonce = Buffer.from(hashAppleNonce(rawNonce), 'ascii');
      if (
        typeof payload.nonce !== 'string' ||
        !/^[a-f0-9]{64}$/.test(payload.nonce) ||
        !timingSafeEqual(Buffer.from(payload.nonce, 'ascii'), expectedNonce)
      ) {
        throw new AppleNonceVerificationError();
      }
      return { subject: payload.sub };
    } catch (error) {
      // Do not expose jose/JWKS errors or any token claims to API callers.
      if (error instanceof AppleNonceVerificationError) throw error;
      throw new AppleTokenVerificationError();
    }
  }
}

export function createProductionAppleIdentityVerifier(): ProductionAppleIdentityVerifier {
  const audience = process.env.APPLE_AUDIENCE ?? process.env.APPLE_BUNDLE_ID;
  if (audience === undefined || audience.trim().length === 0) {
    throw new Error('APPLE_AUDIENCE is required for production Apple identity verification');
  }
  return new ProductionAppleIdentityVerifier({ audience });
}
