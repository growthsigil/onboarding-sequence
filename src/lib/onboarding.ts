/**
 * ONBOARDING SEQUENCE - the moment a customer pays, send a warm welcome email
 * with everything they need to get started, then a couple of gentle follow-ups
 * over their first week. Every line is a placeholder-token template each business
 * customizes to its own service.
 *
 * TRIGGER (start): a payment (Stripe / GoHighLevel webhook, or the manual
 *   /api/payment/received endpoint) → startOnboarding() stamps
 *   customers.onboarding_anchor_at (the payment moment), only if the client has
 *   onboarding_enabled. Onboards each customer once.
 *
 * SCHEDULE: one touch per entry in clients.onboarding_offsets (days from the
 *   anchor). Default {0,2,5}:
 *     Touch 1 - day 0  : the welcome + how-to-get-started email (sent instantly).
 *     Touch 2 - day 2  : a short nudge on the key first steps.
 *     Touch 3 - day 5  : a friendly check-in + resources.
 *   Touch 1 fires immediately from the webhook; the rest ride the daily tick.
 *
 * STOP (clears onboarding_anchor_at):
 *   - all touches sent → completed.
 *   - unsubscribe link / manual stop / paused.
 *
 * COPY: default placeholder templates below. {first}, {name}, {business},
 *   {amount}, {product} fill from data; the link/detail tokens
 *   ({calendar_link}, {portal_link}, {onboarding_form_link}, {resource_link},
 *   {community_link}, {login_link}, {support_email}, {support_phone}, {service},
 *   {sender}, {sender_title}) are set per client on onboarding_templates. Any
 *   optional line wrapped in [[if token]]...[[/if]] disappears cleanly when that
 *   token is empty. Set s{n}/t{n} to send your own exact subject/body for a
 *   touch (AI skipped for it).
 *
 * SAFETY: dormant unless clients.onboarding_enabled = true, and only acts on
 *   customers whose anchor is AFTER onboarding_enabled_at. The atomic per-touch
 *   claim (onboarding_log) means the immediate send and the daily tick can never
 *   double-send.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  supabase, logEvent, eventExists, getCustomerById,
  type Client, type Customer,
} from "./supabase";
import { sendOnboardingEmail, unsubscribeUrl } from "./email";
import { sendTelegramPing } from "./telegram";

const MODEL = process.env.ONBOARDING_MODEL || "claude-sonnet-4-6";
const MAX_PER_RUN = 100;
const STALE_CLAIM_MS = 5 * 60_000;

// ── Default copy - placeholder-token templates (subject + body per touch) ─────
export const ONBOARDING_TEMPLATE_DEFAULTS: Array<{ subject: string; body: string }> = [
  {
    subject: "Welcome to {business}, let's get you started 🎉",
    body: `Hi {first},

Welcome aboard, and thank you for joining {business}! We're genuinely excited to work with you.

Here's how to get started:

[[if onboarding_form_link]]• Complete your onboarding form (this helps us tailor everything to you):
{onboarding_form_link}

[[/if]][[if calendar_link]]• Book your kickoff call so we can map out your plan:
{calendar_link}

[[/if]][[if portal_link]]• Access your client portal, where everything lives in one place:
{portal_link}

[[/if]][[if login_link]]• Log in to your account here:
{login_link}

[[/if]]If anything is unclear, just reply to this email[[if support_email]] or reach us at {support_email}[[/if]]. A real person will help you out.

Talk soon,
{sender}
[[if sender_title]]{sender_title}, [[/if]]{business}`,
  },
  {
    subject: "A couple of quick things to set you up",
    body: `Hi {first},

Just following up to make sure you're all set with {business}. If you haven't yet, these two steps make the biggest difference in your first week:

[[if onboarding_form_link]]• Your onboarding form: {onboarding_form_link}
[[/if]][[if calendar_link]]• Your kickoff call: {calendar_link}
[[/if]][[if portal_link]]• Your client portal: {portal_link}
[[/if]]
Once those are done, we can hit the ground running. Anything you're unsure about? Just hit reply. I read every message.

{sender}
{business}`,
  },
  {
    subject: "How's everything going so far?",
    body: `Hi {first},

Quick check-in: how are you finding things so far with {business}?

[[if resource_link]]Here are a few resources that might help as you settle in:
{resource_link}

[[/if]][[if community_link]]And if you'd like to connect with everyone else, come say hi here:
{community_link}

[[/if]][[if calendar_link]]Want to talk something through? Grab a time here:
{calendar_link}

[[/if]]We're here whenever you need us[[if support_email]] at {support_email}[[/if]].

{sender}
[[if sender_title]]{sender_title}, [[/if]]{business}`,
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function firstName(c: Pick<Customer, "full_name" | "email">): string {
  const fn = (c.full_name || "").trim();
  const first = fn ? fn.split(/\s+/)[0] : "";
  if (first && /^[a-zA-Z][a-zA-Z'-]{1,20}$/.test(first)) {
    return first.charAt(0).toUpperCase() + first.slice(1);
  }
  return "";
}

function formatAmount(amount: number | null, currency: string | null): string {
  if (amount == null || !Number.isFinite(Number(amount))) return "";
  const sym: Record<string, string> = { usd: "$", eur: "€", gbp: "£", aud: "$", cad: "$", nzd: "$" };
  const code = (currency || "usd").toLowerCase();
  const prefix = sym[code] || "";
  const n = Math.round(Number(amount)).toLocaleString("en-US");
  return prefix ? `${prefix}${n}` : `${n} ${code.toUpperCase()}`;
}

function normalizeOffsets(raw: number[] | null | undefined): number[] {
  const arr = Array.isArray(raw) ? raw.map(Number).filter((n) => Number.isFinite(n) && n >= 0) : [];
  return arr.length ? arr.slice().sort((a, b) => a - b) : [0, 2, 5];
}

function buildTokens(client: Client, customer: Customer): Record<string, string> {
  const t = (client.onboarding_templates ?? {}) as Record<string, unknown>;
  const first = firstName(customer);
  return {
    first: first || "there",
    name: (customer.full_name || first || "there").trim(),
    business: client.name || "us",
    service: str(t.service),
    sender: str(t.sender) || str(client.from_name),
    sender_title: str(t.sender_title),
    portal_link: str(t.portal_link),
    calendar_link: str(t.calendar_link),
    onboarding_form_link: str(t.onboarding_form_link),
    resource_link: str(t.resource_link),
    community_link: str(t.community_link),
    login_link: str(t.login_link),
    support_email: str(t.support_email) || str(client.reply_to),
    support_phone: str(t.support_phone),
    amount: formatAmount(customer.amount, customer.currency),
    product: str(customer.product),
    unsubscribe_link: unsubscribeUrl(customer),
  };
}

/** Resolve [[if token]]...[[/if]] blocks against the token values. */
function applyConditionals(tpl: string, tokens: Record<string, string>): string {
  return tpl.replace(/\[\[if\s+([a-z_]+)\]\]([\s\S]*?)\[\[\/if\]\]/gi, (_m, name: string, inner: string) => {
    return (tokens[name] || "").trim() ? inner : "";
  });
}

function replaceTokens(tpl: string, tokens: Record<string, string>): string {
  let out = tpl;
  for (const [k, v] of Object.entries(tokens)) out = out.split(`{${k}}`).join(v ?? "");
  return out.replace(/\{[a-z_]+\}/gi, ""); // drop any leftover unknown token
}

function mergeBody(tpl: string, tokens: Record<string, string>): string {
  const merged = replaceTokens(applyConditionals(tpl, tokens), tokens);
  return merged
    .split("\n")
    .map((l) => l.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function mergeSubject(tpl: string, tokens: Record<string, string>): string {
  return replaceTokens(applyConditionals(tpl, tokens), tokens).replace(/\s+/g, " ").trim().slice(0, 200);
}

const REFUSAL_PATTERNS = [/\bI (can ?not|cannot|won'?t|will not|am not able to)\b/i, /\bas an AI\b/i, /\b(inappropriate|potentially harmful)\b/i];

/** Optionally rewrite a touch in the client's voice. Returns null to use the
 *  default template. Never throws. */
async function maybeGenerate(
  client: Client,
  touch: number,
  tokens: Record<string, string>,
  def: { subject: string; body: string }
): Promise<{ subject: string; body: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const voice = str(client.voice_samples);
  const context = str(client.business_context);
  if (!voice && !context) return null; // nothing to personalize with - templates are better
  try {
    const anthropic = new Anthropic({ apiKey });
    const facts = Object.entries(tokens)
      .filter(([k, v]) => v && !["first", "name", "unsubscribe_link"].includes(k))
      .map(([k, v]) => `- ${k}: ${v}`)
      .join("\n");
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      output_config: { effort: "low" },
      system: `You write ONE onboarding email from this business to a customer who just paid. Match the business's voice exactly and NEVER invent facts, links, prices, or promises beyond what is provided.

VOICE SAMPLES:
${voice.slice(0, 1200)}

BUSINESS FACTS (the only facts/links you may use - include the links verbatim, and omit any that aren't provided):
${facts || "(none provided)"}

RULES (never break):
${str(client.active_rules)}

Write warmly and concisely, in plain sentences. Never join two clauses with a dash (em-dash or plain hyphen); use "and", a comma, or a new sentence.

Output format - EXACTLY this, nothing else:
SUBJECT: <one-line subject>
<blank line>
<email body, greeting the customer by first name>`,
      messages: [
        {
          role: "user",
          content: `Customer first name: ${tokens.first}\nThis is email #${touch} of the onboarding sequence.\n\nUse this proven template as the intent/structure to follow (rewrite it in the business's voice, keep any provided links, drop steps whose link isn't provided):\n\n${def.body}`,
        },
      ],
    });
    const txt = res.content.filter((b) => b.type === "text").map((b) => (b as { type: "text"; text: string }).text).join("").trim();
    if (!txt || REFUSAL_PATTERNS.some((re) => re.test(txt))) return null;
    const m = txt.match(/^\s*SUBJECT:\s*(.+?)\s*\n([\s\S]+)$/i);
    if (!m) return null;
    const subject = m[1].trim().slice(0, 200);
    const body = m[2].trim();
    if (!subject || body.length < 20) return null;
    return { subject, body };
  } catch (err) {
    console.error("[onboarding] maybeGenerate failed, using template:", err);
    return null;
  }
}

async function buildEmail(client: Client, customer: Customer, touch: number): Promise<{ subject: string; body: string }> {
  const tokens = buildTokens(client, customer);
  const t = (client.onboarding_templates ?? {}) as Record<string, unknown>;
  const def = ONBOARDING_TEMPLATE_DEFAULTS[touch - 1] ?? ONBOARDING_TEMPLATE_DEFAULTS[ONBOARDING_TEMPLATE_DEFAULTS.length - 1];
  const bodyOverride = str(t[`t${touch}`]);
  const subjOverride = str(t[`s${touch}`]);

  if (bodyOverride) {
    return { subject: mergeSubject(subjOverride || def.subject, tokens), body: mergeBody(bodyOverride, tokens) };
  }
  const ai = await maybeGenerate(client, touch, tokens, def);
  if (ai) return { subject: mergeSubject(subjOverride || ai.subject || def.subject, tokens), body: mergeBody(ai.body, tokens) };
  return { subject: mergeSubject(subjOverride || def.subject, tokens), body: mergeBody(def.body, tokens) };
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC HOOKS
// ─────────────────────────────────────────────────────────────────────────────

/** A customer just paid. Arms the onboarding sequence (dormant unless the client
 *  has onboarding on). Onboards each customer once; pass force to re-onboard. */
export async function startOnboarding(params: {
  client: Client;
  customer: Customer;
  source: string;
  paidAt?: string | null;
  force?: boolean;
}): Promise<boolean> {
  const { client, customer, source, force } = params;
  try {
    // Callers log "payment_received"; here we only arm when onboarding is on.
    if (!client.onboarding_enabled) return false;
    if (customer.unsubscribed || customer.paused) return false;
    if (!force) {
      if (customer.onboarding_anchor_at) return false; // already in sequence
      if (await eventExists(customer.id, "onboarding_started")) return false; // onboard once
    }
    const anchor = params.paidAt || customer.paid_at || new Date().toISOString();
    let armed = false;
    if (force) {
      const { data } = await supabase.from("customers").update({ onboarding_anchor_at: anchor, paid_at: customer.paid_at ?? anchor }).eq("id", customer.id).select("id");
      armed = !!(data ?? []).length;
    } else {
      const { data } = await supabase.from("customers").update({ onboarding_anchor_at: anchor, paid_at: customer.paid_at ?? anchor }).eq("id", customer.id).is("onboarding_anchor_at", null).select("id");
      armed = !!(data ?? []).length;
    }
    if (!armed) return false;
    await logEvent({ client_id: client.id, customer_id: customer.id, event_type: "onboarding_started", metadata: { source, anchor } });
    await sendTelegramPing(
      `🎉 New customer onboarding: ${customer.full_name || customer.email || customer.id}${customer.product ? `, ${customer.product}` : ""} (${client.name})`
    ).catch(() => {});
    return true;
  } catch (err) {
    console.error("[onboarding] startOnboarding failed:", err);
    return false;
  }
}

/** Stop the sequence for a customer (unsubscribe / manual / exhausted). */
export async function stopOnboarding(clientId: string, customerId: string, reason: string): Promise<boolean> {
  try {
    const { data } = await supabase.from("customers").update({ onboarding_anchor_at: null }).eq("id", customerId).not("onboarding_anchor_at", "is", null).select("id");
    const was = !!(data ?? []).length;
    if (was) await logEvent({ client_id: clientId, customer_id: customerId, event_type: "onboarding_stopped", metadata: { reason } });
    return was;
  } catch (err) {
    console.error("[onboarding] stopOnboarding failed:", err);
    return false;
  }
}

async function markCompleted(client: Client, customer: Customer): Promise<void> {
  if (await eventExists(customer.id, "onboarding_completed")) return;
  await logEvent({ client_id: client.id, customer_id: customer.id, event_type: "onboarding_completed", metadata: {} });
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-CUSTOMER PROCESSOR - send the one due touch, if any. Returns 1 if sent.
// ─────────────────────────────────────────────────────────────────────────────
async function processCustomer(client: Client, customer: Customer, now: number): Promise<number> {
  const anchorIso = customer.onboarding_anchor_at;
  if (!anchorIso) return 0;
  if (customer.unsubscribed || customer.paused) {
    await stopOnboarding(client.id, customer.id, customer.unsubscribed ? "unsubscribed" : "paused");
    return 0;
  }
  const provider = (client.email_provider || "resend").toLowerCase();
  if (provider !== "ghl" && !customer.email) {
    await stopOnboarding(client.id, customer.id, "no_email");
    return 0;
  }
  if (provider === "ghl" && !customer.ghl_contact_id) {
    await stopOnboarding(client.id, customer.id, "no_ghl_contact");
    return 0;
  }

  const enabledAt = client.onboarding_enabled_at ? new Date(client.onboarding_enabled_at).getTime() : 0;
  const anchorMs = new Date(anchorIso).getTime();
  if (anchorMs < enabledAt) {
    await stopOnboarding(client.id, customer.id, "before_enable");
    return 0;
  }

  const offsets = normalizeOffsets(client.onboarding_offsets);

  const { data: prior } = await supabase.from("onboarding_log").select("touch, sent_at, status").eq("customer_id", customer.id).eq("anchor", anchorIso);
  const rows = (prior ?? []) as { touch: number; sent_at: string | null; status: string }[];

  // Abandon stale 'sending' claims (a crashed send) so the ledger is truthful.
  const hasStale = rows.some((r) => r.status === "sending" && r.sent_at != null && new Date(r.sent_at).getTime() < now - STALE_CLAIM_MS);
  if (hasStale) {
    await supabase.from("onboarding_log").update({ status: "abandoned" }).eq("customer_id", customer.id).eq("anchor", anchorIso).eq("status", "sending").lt("sent_at", new Date(now - STALE_CLAIM_MS).toISOString());
  }

  const touchesSent = rows.length;
  if (touchesSent >= offsets.length) {
    await stopOnboarding(client.id, customer.id, "exhausted");
    await markCompleted(client, customer);
    return 0;
  }

  const daysSince = (now - anchorMs) / 86_400_000;
  if (daysSince + 1e-9 < offsets[touchesSent]) return 0; // not due yet

  const touch = touchesSent + 1;

  // Atomic claim - the immediate send and the daily tick cannot both take it.
  const { data: claimed } = await supabase
    .from("onboarding_log")
    .upsert(
      { client_id: client.id, customer_id: customer.id, anchor: anchorIso, touch, status: "sending", provider },
      { onConflict: "customer_id,anchor,touch", ignoreDuplicates: true }
    )
    .select("id");
  const row = (claimed ?? [])[0] as { id: string } | undefined;
  if (!row) return 0; // someone else claimed it

  const { subject, body } = await buildEmail(client, customer, touch);
  const res = await sendOnboardingEmail({ client, customer, subject, bodyText: body });

  if (!res.success) {
    await supabase.from("onboarding_log").update({ status: "failed", subject, error: (res.error || "").slice(0, 400) }).eq("id", row.id);
    await logEvent({ client_id: client.id, customer_id: customer.id, event_type: "onboarding_send_failed", metadata: { touch, error: res.error } });
    // Ping the owner at most once an hour so a misconfiguration is noticed fast.
    const { data: recent } = await supabase.from("events").select("id").eq("client_id", client.id).eq("event_type", "onboarding_send_failed").gte("created_at", new Date(now - 3600_000).toISOString()).limit(2);
    if (((recent ?? []).length) <= 1) {
      await sendTelegramPing(`🛑 An onboarding email failed to send for ${client.name} (${res.provider}). Check the email settings.\n${(res.error || "").slice(0, 200)}`).catch(() => {});
    }
    return 0;
  }

  await supabase.from("onboarding_log").update({ status: "sent", subject, provider_message_id: res.provider_message_id ?? null, sent_at: new Date().toISOString() }).eq("id", row.id);
  await logEvent({ client_id: client.id, customer_id: customer.id, event_type: "onboarding_sent", metadata: { touch, provider: res.provider } });

  if (touch >= offsets.length) {
    await stopOnboarding(client.id, customer.id, "exhausted");
    await markCompleted(client, customer);
  }
  return 1;
}

/** Immediate path - send the day-0 welcome right after a payment arms the
 *  sequence. Safe to call from the webhook via waitUntil. */
export async function runOnboardingForCustomer(client: Client, customerId: string): Promise<number> {
  try {
    const customer = await getCustomerById(customerId);
    if (!customer) return 0;
    return await processCustomer(client, customer, Date.now());
  } catch (err) {
    console.error("[onboarding] runOnboardingForCustomer failed:", err);
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SWEEP - send any due touch for every customer in a sequence.
// ─────────────────────────────────────────────────────────────────────────────
export async function runOnboarding(): Promise<{ enabled: number; sent: number }> {
  let sent = 0;
  try {
    const { data } = await supabase.from("clients").select("*").eq("onboarding_enabled", true);
    const clients = (data as Client[] | null) ?? [];
    if (!clients.length) return { enabled: 0, sent: 0 };
    const now = Date.now();

    for (const client of clients) {
      const { data: custs } = await supabase
        .from("customers")
        .select("*")
        .eq("client_id", client.id)
        .eq("paused", false)
        .eq("unsubscribed", false)
        .not("onboarding_anchor_at", "is", null)
        .order("onboarding_anchor_at", { ascending: true })
        .limit(300);

      for (const c of (custs ?? []) as Customer[]) {
        if (sent >= MAX_PER_RUN) break;
        try {
          sent += await processCustomer(client, c, now);
        } catch (e) {
          console.error("[onboarding] customer failed:", c.id, e);
        }
      }
      if (sent >= MAX_PER_RUN) break;
    }
    return { enabled: clients.length, sent };
  } catch (err) {
    console.error("[onboarding] runOnboarding failed:", err);
    return { enabled: 0, sent };
  }
}
