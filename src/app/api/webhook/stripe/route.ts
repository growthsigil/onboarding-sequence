/**
 * Stripe webhook - the "customer paid" signal.
 *
 * In Stripe → Developers → Webhooks, add an endpoint pointing at:
 *   https://YOUR-APP/api/webhook/stripe?client=<your-slug>
 * (the ?client= is optional if you run a single business). Subscribe to:
 *   - checkout.session.completed          (one-time + first subscription payment)
 *   - invoice.paid                        (subscriptions; first invoice only)
 * Copy the signing secret (whsec_...) into STRIPE_WEBHOOK_SECRET.
 */
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getClient, findOrCreateCustomer, logEvent } from "@/lib/supabase";
import { startOnboarding, runOnboardingForCustomer } from "@/lib/onboarding";
import { verifyStripeSignature } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Json = Record<string, unknown>;
const asObj = (v: unknown): Json => (v && typeof v === "object" ? (v as Json) : {});
const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const asNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Pull the customer details from the relevant Stripe event types. */
function extract(event: Json): { email: string | null; name: string | null; amount: number | null; currency: string | null; product: string | null; externalId: string | null; metaSlug: string | null } | "ignore" {
  const type = asStr(event.type) || "";
  const obj = asObj(asObj(event.data).object);
  const meta = asObj(obj.metadata);
  const metaSlug = asStr(meta.client) || asStr(meta.client_slug);

  if (type === "checkout.session.completed") {
    const details = asObj(obj.customer_details);
    const cents = asNum(obj.amount_total);
    return {
      email: asStr(details.email) || asStr(obj.customer_email),
      name: asStr(details.name),
      amount: cents != null ? cents / 100 : null,
      currency: asStr(obj.currency),
      product: asStr(meta.product) || asStr(obj.description),
      externalId: asStr(obj.customer) || asStr(obj.id),
      metaSlug,
    };
  }

  if (type === "invoice.paid" || type === "invoice.payment_succeeded") {
    // Only the FIRST subscription invoice onboards; later renewals must not.
    const reason = asStr(obj.billing_reason);
    if (reason && reason !== "subscription_create") return "ignore";
    const cents = asNum(obj.amount_paid);
    return {
      email: asStr(obj.customer_email),
      name: asStr(obj.customer_name),
      amount: cents != null ? cents / 100 : null,
      currency: asStr(obj.currency),
      product: asStr(meta.product),
      externalId: asStr(obj.customer),
      metaSlug,
    };
  }

  if (type === "payment_intent.succeeded") {
    const charges = asObj(obj.charges);
    const first = asObj((Array.isArray(charges.data) ? charges.data[0] : undefined));
    const billing = asObj(first.billing_details);
    const cents = asNum(obj.amount);
    return {
      email: asStr(obj.receipt_email) || asStr(billing.email),
      name: asStr(billing.name),
      amount: cents != null ? cents / 100 : null,
      currency: asStr(obj.currency),
      product: asStr(meta.product) || asStr(obj.description),
      externalId: asStr(obj.customer) || asStr(obj.id),
      metaSlug,
    };
  }

  return "ignore";
}

export async function POST(req: NextRequest) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ ok: false, reason: "stripe_not_configured" }, { status: 500 });

  const raw = await req.text();
  if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ ok: false, reason: "bad_signature" }, { status: 400 });
  }

  let event: Json;
  try {
    event = JSON.parse(raw) as Json;
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }

  const info = extract(event);
  if (info === "ignore") return NextResponse.json({ ok: true, skipped: "event_type" });
  if (!info.email) return NextResponse.json({ ok: true, skipped: "no_email" });

  const querySlug = new URL(req.url).searchParams.get("client")?.trim() || undefined;
  const client = await getClient(querySlug || info.metaSlug || undefined);
  if (!client) return NextResponse.json({ ok: true, skipped: "no_client" });

  const paidAt = new Date().toISOString();
  const customer = await findOrCreateCustomer({
    client_id: client.id,
    email: info.email,
    full_name: info.name,
    external_id: info.externalId,
    paid_at: paidAt,
    amount: info.amount,
    currency: info.currency,
    product: info.product,
  });

  await logEvent({ client_id: client.id, customer_id: customer.id, event_type: "payment_received", metadata: { source: "stripe", type: event.type } });
  const armed = await startOnboarding({ client, customer, source: "stripe", paidAt });
  if (armed) waitUntil(runOnboardingForCustomer(client, customer.id)); // send the welcome now

  return NextResponse.json({ ok: true, armed, customer_id: customer.id });
}
