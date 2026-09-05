/**
 * Email delivery - one call, two providers. Each client picks its provider via
 * clients.email_provider:
 *   'resend' (default) - the simplest to set up fresh; needs RESEND_API_KEY and
 *                        a verified from_email on the client row.
 *   'ghl'              - send through the business's existing GoHighLevel email;
 *                        needs the customer's ghl_contact_id + the location token.
 */
import { renderEmailHtml } from "./text";
import { sendGHLEmail, type SendResult } from "./ghl";
import type { Client, Customer } from "./supabase";

export type { SendResult };

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export function unsubscribeUrl(customer: Pick<Customer, "id" | "unsub_token">): string {
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  return `${base}/api/unsubscribe?c=${customer.id}&t=${customer.unsub_token}`;
}

function fromLine(client: Client): string {
  const email = (client.from_email || "").trim();
  const name = (client.from_name || "").trim();
  if (!email) return "";
  return name ? `${name} <${email}>` : email;
}

async function sendViaResend(params: {
  from: string;
  to: string;
  replyTo?: string | null;
  subject: string;
  html: string;
  text: string;
  unsub?: string;
}): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { success: false, error: "RESEND_API_KEY not set" };
  if (!params.from) return { success: false, error: "client.from_email not set" };
  try {
    const body: Record<string, unknown> = {
      from: params.from,
      to: [params.to],
      subject: params.subject,
      html: params.html,
      text: params.text,
    };
    if (params.replyTo) body.reply_to = params.replyTo;
    if (params.unsub) body.headers = { "List-Unsubscribe": `<${params.unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { success: false, error: `Resend ${res.status}: ${t.slice(0, 300)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { success: true, provider_message_id: data.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Render + send one onboarding email to a customer via the client's provider. */
export async function sendOnboardingEmail(params: {
  client: Client;
  customer: Customer;
  subject: string;
  bodyText: string;
}): Promise<SendResult & { provider: string }> {
  const { client, customer, subject, bodyText } = params;
  const provider = (client.email_provider || "resend").toLowerCase();
  const unsub = unsubscribeUrl(customer);
  const preheader = bodyText.replace(/\s+/g, " ").trim().slice(0, 140);
  const html = renderEmailHtml({ business: client.name, bodyText, unsubscribeUrl: unsub, preheader });

  if (provider === "ghl") {
    if (!client.ghl_api_key) return { success: false, provider, error: "client.ghl_api_key not set" };
    if (!customer.ghl_contact_id) return { success: false, provider, error: "customer has no ghl_contact_id" };
    const r = await sendGHLEmail({
      ghl_api_key: client.ghl_api_key,
      ghl_contact_id: customer.ghl_contact_id,
      subject,
      html,
      text: bodyText,
      emailFrom: fromLine(client) || undefined,
    });
    return { ...r, provider };
  }

  // default: resend
  if (!customer.email) return { success: false, provider, error: "customer has no email" };
  const r = await sendViaResend({
    from: fromLine(client),
    to: customer.email,
    replyTo: client.reply_to,
    subject,
    html,
    text: bodyText,
    unsub,
  });
  return { ...r, provider };
}
