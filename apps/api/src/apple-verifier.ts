import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

export interface VerifiedAppleIdentity {
  readonly subject: string;
}

export interface AppleIdentityVerifier {
  verify(identityToken: string): Promise<VerifiedAppleIdentity>;
}

export class UnavailableAppleIdentityVerifier implements AppleIdentityVerifier {
  async verify(_identityToken: string): Promise<VerifiedAppleIdentity> {
    throw new AppleTokenVerificationError();
  }
}

export class AppleTokenVerificationError extends Error {
  constructor() {
    super('apple_identity_token_invalid');
    this.name = 'AppleTokenVerificationError';
  }
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

  async verify(identityToken: string): Promise<VerifiedAppleIdentity> {
    if (identityToken.length === 0 || identityToken.length > 16_384) {
      throw new AppleTokenVerificationError();
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
        typeof payload.exp !== 'number' ||
        payload.exp * 1_000 <= Date.now()
      ) {
        throw new AppleTokenVerificationError();
      }
      return { subject: payload.sub };
    } catch {
      // Do not expose jose/JWKS errors or any token claims to API callers.
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
