/**
 * Constant-time string comparison for cron/webhook shared-secret checks
 * (workday-verification-worker, email-tracking-worker). A plain `!==`
 * on the raw secret short-circuits at the first mismatched byte, which
 * is a real (if narrow) timing side-channel on an internet-reachable
 * endpoint that skips JWT verification (--no-verify-jwt) and relies on
 * this header as its only auth. Hashing both sides first means the byte
 * comparison always runs over a fixed-length digest regardless of the
 * two input lengths, so neither the actual secret's length nor its
 * content can be inferred from response timing.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(digestA);
  const bytesB = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}
