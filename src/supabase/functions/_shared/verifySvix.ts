/**
 * Svix webhook signature verification, as used by Resend (inbound email
 * and event webhooks). A Resend inbound endpoint has a signing secret of
 * the form `whsec_<base64>`; the request carries `svix-id`,
 * `svix-timestamp`, and `svix-signature` headers, where the signature is
 * a space-separated list of `v1,<base64 hmac>` entries (one per active
 * secret during a rotation). The signed content is
 * `${svix-id}.${svix-timestamp}.${rawBody}`.
 *
 * No `svix` npm dependency: the algorithm is small and stable, and this
 * runs in Deno Edge where every extra import is cold-start weight.
 */

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Returns true when `rawBody` carries a valid Svix signature for one of
 * the given secrets and the timestamp is within tolerance. `secret` may
 * be a comma-separated list to support rotation. A `whsec_` prefix is
 * optional and stripped.
 */
export async function verifySvix(req: Request, rawBody: string, secret: string): Promise<boolean> {
  const id = req.headers.get("svix-id");
  const timestamp = req.headers.get("svix-timestamp");
  const signatureHeader = req.headers.get("svix-signature");
  if (!id || !timestamp || !signatureHeader || !secret) return false;

  const ts = Number(timestamp) * 1000;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > FIVE_MINUTES_MS) return false;

  const signedContent = `${id}.${timestamp}.${rawBody}`;
  const provided = signatureHeader
    .split(" ")
    .map((part) => part.split(",", 2)[1])
    .filter((s): s is string => Boolean(s));
  if (provided.length === 0) return false;

  const enc = new TextEncoder();
  for (const rawSecret of secret.split(",").map((s) => s.trim()).filter(Boolean)) {
    const keyBytes = base64ToBytes(rawSecret.replace(/^whsec_/, ""));
    const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(signedContent)));
    for (const candidate of provided) {
      if (constantTimeEqual(mac, base64ToBytes(candidate))) return true;
    }
  }
  return false;
}
