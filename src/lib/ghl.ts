/**
 * Minimal GoHighLevel email client. Used when a client's email_provider = 'ghl'
 * so the onboarding emails go out through their existing GHL sending domain.
 * Auth is a per-location Private Integration Token (clients.ghl_api_key).
 */
const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-04-15";

export interface SendGHLEmailParams {
  ghl_api_key: string;
  ghl_contact_id: string;
  subject: string;
  html: string;
  text?: string;
  emailFrom?: string; // "Name <address>" - optional; GHL falls back to the location default
}

export interface SendResult {
  success: boolean;
  provider_message_id?: string;
  error?: string;
}

export async function sendGHLEmail(params: SendGHLEmailParams): Promise<SendResult> {
  try {
    const body: Record<string, unknown> = {
      type: "Email",
      contactId: params.ghl_contact_id,
      subject: params.subject,
      html: params.html,
    };
    if (params.text) body.message = params.text;
    if (params.emailFrom) body.emailFrom = params.emailFrom;

    const res = await fetch(`${GHL_API_BASE}/conversations/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.ghl_api_key}`,
        "Content-Type": "application/json",
        Version: GHL_API_VERSION,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { success: false, error: `GHL ${res.status}: ${t.slice(0, 300)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { messageId?: string; id?: string };
    return { success: true, provider_message_id: data.messageId ?? data.id };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Look up a GHL contact id by email (so a Stripe payment can be onboarded via
 *  GHL email). Returns null when not found or on error. */
export async function findGHLContactByEmail(ghl_api_key: string, locationId: string, email: string): Promise<string | null> {
  try {
    const url = `${GHL_API_BASE}/contacts/?locationId=${encodeURIComponent(locationId)}&query=${encodeURIComponent(email)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${ghl_api_key}`, Version: GHL_API_VERSION },
    });
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { contacts?: Array<{ id?: string; email?: string }> };
    const match = (data.contacts ?? []).find((c) => (c.email || "").toLowerCase() === email.toLowerCase());
    return match?.id ?? data.contacts?.[0]?.id ?? null;
  } catch {
    return null;
  }
}
