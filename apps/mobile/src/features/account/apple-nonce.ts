import { APPLE_RAW_NONCE_LENGTH, isValidAppleRawNonce } from '@alyte/contracts';

export type AppleNonce = {
  readonly rawNonce: string;
  readonly hashedNonce: string;
};

export type AppleNonceGenerator = () => Promise<AppleNonce>;

const NONCE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._';
const RANDOM_BYTE_BUCKET = Math.floor(256 / NONCE_ALPHABET.length) * NONCE_ALPHABET.length;

function encodeRandomNonce(bytes: Uint8Array): string {
  let rawNonce = '';
  for (const byte of bytes) {
    if (byte >= RANDOM_BYTE_BUCKET) continue;
    rawNonce += NONCE_ALPHABET[byte % NONCE_ALPHABET.length];
    if (rawNonce.length === APPLE_RAW_NONCE_LENGTH) return rawNonce;
  }
  throw new Error('apple_nonce_entropy_insufficient');
}

/**
 * Generates the raw value in memory only. Apple receives the SHA-256 digest while Alyte's
 * exchange receives the raw value so the backend can verify the token claim.
 */
export async function createAppleNonce(): Promise<AppleNonce> {
  const crypto = await import('expo-crypto');
  const randomBytes = await crypto.getRandomBytesAsync(APPLE_RAW_NONCE_LENGTH + 16);
  const rawNonce = encodeRandomNonce(randomBytes);
  if (!isValidAppleRawNonce(rawNonce)) throw new Error('apple_nonce_invalid');
  const hashedNonce = await crypto.digestStringAsync(
    crypto.CryptoDigestAlgorithm.SHA256,
    rawNonce,
    { encoding: crypto.CryptoEncoding.HEX },
  );
  if (!/^[a-f0-9]{64}$/.test(hashedNonce)) throw new Error('apple_nonce_digest_invalid');
  return { rawNonce, hashedNonce };
}
