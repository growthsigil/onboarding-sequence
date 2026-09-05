/**
 * Dashboard - customers onboarded, how many are mid-sequence, emails sent, and
 * the most recent sends. Server component; reads Supabase directly.
 */
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function fmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: "#151a23", border: "1px solid #232b38", borderRadius: 12, padding: "16px 18px" }}>
      <div style={{ fontSize: 25, fontWeight: 700, letterSpacing: "-0.02em" }}>{value}</div>
      <div style={{ color: "#8b95a7", fontSize: 12.5, marginTop: 2 }}>{label}</div>
    </div>
  );
}

const badge: Record<string, string> = { sent: "#2f9e6f", sending: "#4a90d9", failed: "#d95757", skipped: "#8b95a7", abandoned: "#8b95a7" };

type LogRow = {
  touch: number;
  subject: string | null;
  status: string;
  sent_at: string | null;
  provider: string | null;
  customers: { full_name: string | null; email: string | null } | { full_name: string | null; email: string | null }[] | null;
};

function customerLabel(row: LogRow): string {
  const c = Array.isArray(row.customers) ? row.customers[0] : row.customers;
  return c?.full_name || c?.email || "A customer";
}

export default async function Home() {
  const head = { count: "exact" as const, head: true };
  const [onboarded, inSeq, emailsSent, completed, recentRes] = await Promise.all([
    supabase.from("events").select("id", head).eq("event_type", "onboarding_started"),
    supabase.from("customers").select("id", head).not("onboarding_anchor_at", "is", null),
    supabase.from("onboarding_log").select("id", head).eq("status", "sent"),
    supabase.from("events").select("id", head).eq("event_type", "onboarding_completed"),
    supabase
      .from("onboarding_log")
      .select("touch, subject, status, sent_at, provider, customers(full_name, email)")
      .order("sent_at", { ascending: false })
      .limit(12),
  ]);

  const recent = (recentRes.data as LogRow[] | null) ?? [];

  const hasSupabase = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;
  const hasResend = !!process.env.RESEND_API_KEY;
  const hasStripe = !!process.env.STRIPE_WEBHOOK_SECRET;
  const hasGhl = !!process.env.GHL_WEBHOOK_SECRET;

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "52px 20px 72px" }}>
      <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase", color: "#2f6df6" }}>
        Onboarding Sequence
      </div>
      <h1 style={{ fontSize: 30, lineHeight: 1.1, margin: "10px 0 8px", letterSpacing: "-0.02em" }}>
        Welcomed the moment they pay.
      </h1>
      <p style={{ color: "#8b95a7", fontSize: 15, lineHeight: 1.55, margin: "0 0 26px", maxWidth: "60ch" }}>
        The second a customer pays, they get a warm welcome email with everything they need to get started, followed by a
        couple of gentle nudges over their first week. Every line is yours to customize.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 26 }}>
        <Stat label="onboarded" value={onboarded.count ?? 0} />
        <Stat label="in sequence" value={inSeq.count ?? 0} />
        <Stat label="emails sent" value={emailsSent.count ?? 0} />
        <Stat label="completed" value={completed.count ?? 0} />
      </div>

      <h2 style={{ fontSize: 16, margin: "0 0 12px" }}>Recent emails</h2>
      {recent.length === 0 ? (
        <p style={{ color: "#8b95a7", fontSize: 14 }}>None yet. As soon as a customer pays, their welcome email shows up here.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {recent.map((r, i) => (
            <div key={i} style={{ background: "#151a23", border: "1px solid #232b38", borderRadius: 10, padding: "12px 14px", display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{customerLabel(r)}</div>
                <div style={{ color: "#8b95a7", fontSize: 12.5, marginTop: 3, lineHeight: 1.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.subject || "(no subject)"}
                </div>
                <div style={{ color: "#5f6b7e", fontSize: 11.5, marginTop: 4, fontFamily: "ui-monospace, monospace" }}>
                  email #{r.touch}{r.provider ? ` · ${r.provider}` : ""}{r.sent_at ? ` · ${fmt(r.sent_at)}` : ""}
                </div>
              </div>
              <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: badge[r.status] || "#8b95a7", border: `1px solid ${badge[r.status] || "#8b95a7"}`, borderRadius: 100, padding: "2px 8px", whiteSpace: "nowrap" }}>{r.status}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ borderTop: "1px solid #232b38", marginTop: 28, paddingTop: 18, color: "#5f6b7e", fontSize: 12.5, lineHeight: 1.7 }}>
        <b style={{ color: "#8b95a7" }}>Setup:</b> Supabase {hasSupabase ? "✓" : "✗"} · Resend {hasResend ? "✓" : "✗"} · Stripe {hasStripe ? "✓" : "✗"} · GHL {hasGhl ? "✓" : "✗"}.
        Point your payment webhook at <code>/api/webhook/stripe</code> or <code>/api/webhook/ghl</code>. See the README.
      </div>
    </main>
  );
}
