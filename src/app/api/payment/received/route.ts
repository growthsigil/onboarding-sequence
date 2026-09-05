/**
 * Manually record a payment (arms the onboarding sequence). Handy for testing,
 * for backfilling, or for wiring a payment source that isn't Stripe/GHL.
 *
 *   POST /api/payment/received   (Authorization: Bearer <CRON_SECRET>  or  ?key=<CRON_SECRET>)
 *   body: { "client": "<slug>", "email": "jane@x.com", "full_name": "Jane Doe",
 *           "amount": 1000, "currency": "usd", "product": "The Program",
 *           "ghl_contact_id": "...", "force": false }
 */
import { NextRequest, NextResponse } from "next/server";
import { getClient, findOrCreateCustomer, logEvent } from "@/lib/supabase";
import { startOnboarding, runOnboardingForCustomer } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return req.headers.get("authorization") === `Bearer ${secret}` || new URL(req.url).searchParams.get("key") === secret;
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }

  const slug = typeof body.client === "string" ? body.client : undefined;
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email) return NextResponse.json({ ok: false, reason: "missing email" }, { status: 400 });

  const client = await getClient(slug);
  if (!client) return NextResponse.json({ ok: false, reason: "no_client" }, { status: 404 });

  const paidAt = typeof body.paid_at === "string" && body.paid_at ? body.paid_at : new Date().toISOString();
  const amount = typeof body.amount === "number" ? body.amount : typeof body.amount === "string" ? parseFloat(body.amount) : null;
  const customer = await findOrCreateCustomer({
    client_id: client.id,
    email,
    full_name: (typeof body.full_name === "string" && body.full_name) || null,
    phone: (typeof body.phone === "string" && body.phone) || null,
    ghl_contact_id: (typeof body.ghl_contact_id === "string" && body.ghl_contact_id) || null,
    paid_at: paidAt,
    amount: Number.isFinite(amount as number) ? (amount as number) : null,
    currency: (typeof body.currency === "string" && body.currency) || null,
    product: (typeof body.product === "string" && body.product) || null,
  });

  await logEvent({ client_id: client.id, customer_id: customer.id, event_type: "payment_received", metadata: { source: "manual" } });
  const armed = await startOnboarding({ client, customer, source: "manual", paidAt, force: body.force === true });
  let sent = 0;
  if (armed) sent = await runOnboardingForCustomer(client, customer.id); // send the welcome now (awaited for test feedback)

  return NextResponse.json({ ok: true, customer_id: customer.id, armed, sent, enabled: client.onboarding_enabled });
}
