/**
 * GoHighLevel webhook - the "customer paid" signal for GHL users.
 *
 * Point a GHL workflow at this URL (POST) with a custom header
 * `x-webhook-secret: <GHL_WEBHOOK_SECRET>`:
 *   Trigger: Order Form Submitted / Payment Received (or a "paid" tag / pipeline
 *   stage). Each firing arms the onboarding sequence for that contact.
 */
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { getClientByGHLLocation, getClient, findOrCreateCustomer, logEvent } from "@/lib/supabase";
import { startOnboarding, runOnboardingForCustomer } from "@/lib/onboarding";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

interface GHLPayload {
  contact_id?: string;
  first_name?: string;
  last_name?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  amount?: number | string;
  total?: number | string;
  currency?: string;
  product?: string;
  productName?: string;
  customData?: { contactId?: string; locationId?: string; [k: string]: unknown };
  location?: { id?: string };
  contact?: { id?: string; firstName?: string; lastName?: string; name?: string; email?: string; phone?: string };
  payment?: { amount?: number | string; currency?: string };
}

function authorized(req: NextRequest): boolean {
  const expected = process.env.GHL_WEBHOOK_SECRET;
  if (!expected) return true;
  return req.headers.get("x-webhook-secret") === expected;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export async function POST(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });

  let body: GHLPayload;
  try {
    body = (await req.json()) as GHLPayload;
  } catch {
    return NextResponse.json({ ok: false, reason: "bad_json" }, { status: 400 });
  }

  const locationId = body.location?.id || body.customData?.locationId;
  const contactId = body.customData?.contactId || body.contact_id || body.contact?.id || null;
  const email = (body.email || body.contact?.email || "").trim() || null;
  const querySlug = new URL(req.url).searchParams.get("client")?.trim() || undefined;

  const client = (locationId ? await getClientByGHLLocation(locationId) : null) ?? (await getClient(querySlug));
  if (!client) return NextResponse.json({ ok: true, skipped: "no_client" });
  if (!email) return NextResponse.json({ ok: true, skipped: "no_email" });

  const fullName =
    body.full_name ||
    body.contact?.name ||
    [body.first_name || body.contact?.firstName, body.last_name || body.contact?.lastName].filter(Boolean).join(" ") ||
    null;

  const paidAt = new Date().toISOString();
  const customer = await findOrCreateCustomer({
    client_id: client.id,
    email,
    full_name: fullName,
    phone: body.phone || body.contact?.phone || null,
    ghl_contact_id: contactId,
    external_id: contactId,
    paid_at: paidAt,
    amount: num(body.amount) ?? num(body.total) ?? num(body.payment?.amount),
    currency: body.currency || body.payment?.currency || null,
    product: body.product || body.productName || null,
  });

  await logEvent({ client_id: client.id, customer_id: customer.id, event_type: "payment_received", metadata: { source: "ghl" } });
  const armed = await startOnboarding({ client, customer, source: "ghl", paidAt });
  if (armed) waitUntil(runOnboardingForCustomer(client, customer.id)); // send the welcome now

  return NextResponse.json({ ok: true, armed, customer_id: customer.id });
}
