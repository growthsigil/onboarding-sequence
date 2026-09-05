/**
 * Supabase client (service role) + typed helpers. Service role bypasses RLS, so
 * this only ever runs on the server.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("[supabase] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set.");
}
export const supabase = createClient(url ?? "", serviceKey ?? "", { auth: { persistSession: false } });

export type Client = {
  id: string;
  name: string;
  slug: string;
  onboarding_enabled: boolean;
  onboarding_enabled_at: string | null;
  email_provider: string;
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  ghl_location_id: string | null;
  ghl_api_key: string | null;
  onboarding_offsets: number[] | null;
  onboarding_templates: Record<string, unknown> | null;
  voice_samples: string | null;
  business_context: string | null;
  active_rules: string | null;
  created_at: string;
  updated_at: string;
};

export type Customer = {
  id: string;
  client_id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  ghl_contact_id: string | null;
  external_id: string | null;
  paid_at: string | null;
  amount: number | null;
  currency: string | null;
  product: string | null;
  onboarding_anchor_at: string | null;
  unsub_token: string;
  unsubscribed: boolean;
  paused: boolean;
  created_at: string;
  updated_at: string;
};

/** Look up a client by slug, or return the only client when there's exactly one. */
export async function getClient(slug?: string): Promise<Client | null> {
  if (slug) {
    const { data } = await supabase.from("clients").select("*").eq("slug", slug).maybeSingle();
    return (data as Client | null) ?? null;
  }
  const { data } = await supabase.from("clients").select("*").limit(2);
  const rows = (data as Client[] | null) ?? [];
  return rows.length === 1 ? rows[0] : null;
}

export async function getClientByGHLLocation(locationId: string): Promise<Client | null> {
  const { data } = await supabase.from("clients").select("*").eq("ghl_location_id", locationId).maybeSingle();
  return (data as Client | null) ?? null;
}

export async function getCustomerByEmail(clientId: string, email: string): Promise<Customer | null> {
  const { data } = await supabase
    .from("customers")
    .select("*")
    .eq("client_id", clientId)
    .eq("email", email.toLowerCase())
    .maybeSingle();
  return (data as Customer | null) ?? null;
}

export async function getCustomerById(id: string): Promise<Customer | null> {
  const { data } = await supabase.from("customers").select("*").eq("id", id).maybeSingle();
  return (data as Customer | null) ?? null;
}

/** Find (by email) or create the customer, refreshing the payment context. */
export async function findOrCreateCustomer(params: {
  client_id: string;
  email: string;
  full_name?: string | null;
  phone?: string | null;
  ghl_contact_id?: string | null;
  external_id?: string | null;
  paid_at?: string | null;
  amount?: number | null;
  currency?: string | null;
  product?: string | null;
}): Promise<Customer> {
  const email = params.email.toLowerCase();
  const existing = await getCustomerByEmail(params.client_id, email);
  const patch = {
    client_id: params.client_id,
    email,
    full_name: params.full_name ?? existing?.full_name ?? null,
    phone: params.phone ?? existing?.phone ?? null,
    ghl_contact_id: params.ghl_contact_id ?? existing?.ghl_contact_id ?? null,
    external_id: params.external_id ?? existing?.external_id ?? null,
    paid_at: params.paid_at ?? existing?.paid_at ?? null,
    amount: params.amount ?? existing?.amount ?? null,
    currency: params.currency ?? existing?.currency ?? null,
    product: params.product ?? existing?.product ?? null,
  };
  const { data, error } = await supabase
    .from("customers")
    .upsert(patch, { onConflict: "client_id,email" })
    .select("*")
    .single();
  if (error) throw error;
  return data as Customer;
}

export async function logEvent(params: {
  client_id?: string;
  customer_id?: string;
  event_type: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await supabase.from("events").insert({
    client_id: params.client_id ?? null,
    customer_id: params.customer_id ?? null,
    event_type: params.event_type,
    metadata: params.metadata ?? {},
  });
}

export async function eventExists(customerId: string, eventType: string): Promise<boolean> {
  const { data } = await supabase
    .from("events")
    .select("id")
    .eq("customer_id", customerId)
    .eq("event_type", eventType)
    .limit(1)
    .maybeSingle();
  return !!data;
}
