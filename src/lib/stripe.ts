/**
 * Stripe webhook signature verification - done manually with Node crypto so the
 * project needs no extra dependency and stays pinned to no Stripe API version.
 *
 * Implements Stripe's documented scheme: the `Stripe-Signature` header carries a
 * timestamp (`t=`) and one or more `v1=` HMAC-SHA256 signatures of
 * `${t}.${rawBody}`, keyed by the endpoint's signing secret (`whsec_...`).
 * https://stripe.com/docs/webhooks/signatures
 */
import crypto from "crypto";

const DEFAULT_TOLERANCE_S = 300; // reject events older than 5 minutes (replay guard)

export function verifyStripeSignature(rawBody: string, sigHeader: string | null, secret: string, toleranceSeconds = DEFAULT_TOLERANCE_S): boolean {
  if (!sigHeader || !secret) return false;

  let t = "";
  const v1: string[] = [];
  for (const part of sigHeader.split(",")) {
    const [k, v] = part.split("=");
    if (k === "t") t = (v || "").trim();
    else if (k === "v1") v1.push((v || "").trim());
  }
  if (!t || v1.length === 0) return false;

  // Replay guard.
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const expected = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const expBuf = Buffer.from(expected, "utf8");
  // Constant-time compare against each provided signature.
  return v1.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  });
}
