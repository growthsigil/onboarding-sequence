/**
 * One-click unsubscribe. Linked from every email footer (and the RFC-8058
 * List-Unsubscribe header, which some clients POST to automatically).
 *
 *   GET  /api/unsubscribe?c=<customer_id>&t=<unsub_token>   → confirmation page
 *   POST /api/unsubscribe?c=<customer_id>&t=<unsub_token>   → 200 (one-click)
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase, getCustomerById, logEvent } from "@/lib/supabase";
import { stopOnboarding } from "@/lib/onboarding";

export const dynamic = "force-dynamic";

async function unsubscribe(req: NextRequest): Promise<boolean> {
  const url = new URL(req.url);
  const id = (url.searchParams.get("c") || "").trim();
  const token = (url.searchParams.get("t") || "").trim();
  if (!id || !token) return false;

  const customer = await getCustomerById(id);
  if (!customer || customer.unsub_token !== token) return false;

  await supabase.from("customers").update({ unsubscribed: true, onboarding_anchor_at: null }).eq("id", customer.id);
  await stopOnboarding(customer.client_id, customer.id, "unsubscribed");
  await logEvent({ client_id: customer.client_id, customer_id: customer.id, event_type: "unsubscribed", metadata: {} });
  return true;
}

function page(ok: boolean): string {
  const msg = ok
    ? "You've been unsubscribed. You won't receive any more onboarding emails."
    : "This unsubscribe link is invalid or has expired.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Unsubscribe</title></head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f5f7;color:#1f2937;">
<div style="max-width:480px;margin:15vh auto 0;padding:32px;background:#fff;border:1px solid #e6e8eb;border-radius:12px;text-align:center;">
<div style="font-size:32px;margin-bottom:8px;">${ok ? "✅" : "⚠️"}</div>
<p style="font-size:16px;line-height:1.6;margin:0;">${msg}</p>
</div></body></html>`;
}

export async function GET(req: NextRequest) {
  const ok = await unsubscribe(req);
  return new NextResponse(page(ok), { status: ok ? 200 : 404, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function POST(req: NextRequest) {
  const ok = await unsubscribe(req);
  return NextResponse.json({ ok });
}
