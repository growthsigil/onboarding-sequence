-- ============================================================================
-- Onboarding Sequence - database schema (Supabase / Postgres)
-- ----------------------------------------------------------------------------
-- Run once in the Supabase SQL editor on a fresh project. Idempotent.
--
-- Multi-tenant: one `clients` row per business you run onboarding for.
-- Tables:
--   clients        - a business (its email/GHL settings, timing, and copy)
--   customers      - people who paid; they receive the onboarding sequence
--   onboarding_log - one row per email touch: the atomic claim + dedup ledger
--   events         - a light audit log
-- ============================================================================

create extension if not exists pgcrypto with schema public;


-- ── clients (the tenant business) ───────────────────────────────────────────
create table if not exists public.clients (
    id uuid not null default gen_random_uuid(),
    name text not null,
    slug text not null,
    -- Engine switch. Nothing sends until this is true.
    onboarding_enabled boolean not null default false,
    onboarding_enabled_at timestamp with time zone,
    -- ── Email delivery ──
    -- 'resend' (default, simplest) or 'ghl' (send through GoHighLevel email).
    email_provider text not null default 'resend',
    from_name text,                 -- e.g. 'Alex at Acme'
    from_email text,                -- e.g. 'hello@acme.com' (must be a verified sender)
    reply_to text,                  -- optional reply-to address
    -- ── GoHighLevel (optional) ──
    -- Needed if email_provider = 'ghl', or if payments arrive via a GHL webhook.
    ghl_location_id text,
    ghl_api_key text,               -- per-location Private Integration Token
    -- ── Timing ──
    -- Day offsets from the moment of payment for each email touch. 0 = instantly.
    -- Default {0,2,5} => welcome now, nudge in 2 days, check-in in 5 days.
    onboarding_offsets integer[] not null default '{0,2,5}',
    -- ── Copy ──
    -- Per-client overrides + token values (see src/lib/onboarding.ts):
    --   { "s1":"subject", "t1":"body", "s2":..., "t2":..., "s3":..., "t3":...,
    --     "sender":"Alex", "sender_title":"Founder", "service":"the program",
    --     "portal_link":"https://...", "calendar_link":"https://...",
    --     "onboarding_form_link":"https://...", "resource_link":"https://...",
    --     "community_link":"https://...", "support_email":"help@acme.com",
    --     "support_phone":"..." }
    onboarding_templates jsonb not null default '{}'::jsonb,
    -- ── Optional AI voice (only used when ANTHROPIC_API_KEY is set) ──
    voice_samples text not null default ''::text,
    business_context text not null default ''::text,
    active_rules text not null default ''::text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
);

do $$ begin
    alter table public.clients add constraint clients_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.clients add constraint clients_slug_key UNIQUE (slug);
exception when duplicate_object then null; end $$;


-- ── customers (the people who get onboarded) ────────────────────────────────
create table if not exists public.customers (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    email text,                     -- the natural key: where the sequence is sent
    full_name text,
    phone text,
    ghl_contact_id text,            -- set when the customer / send goes via GHL
    external_id text,               -- e.g. Stripe customer/session id (reference)
    -- Payment context (available as tokens in the copy).
    paid_at timestamp with time zone,
    amount numeric,
    currency text,
    product text,
    -- When set, they're IN the onboarding sequence: the anchor the touches count
    -- from. null => not in sequence. Cleared on unsubscribe / stop / exhausted.
    onboarding_anchor_at timestamp with time zone,
    -- One-time random token for the unsubscribe link.
    unsub_token text not null default replace(gen_random_uuid()::text, '-', ''),
    unsubscribed boolean not null default false,
    paused boolean not null default false,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
);

do $$ begin
    alter table public.customers add constraint customers_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.customers add constraint customers_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
-- Email is the dedup key so a customer is onboarded once even if a webhook fires
-- twice. (A partial unique index would exclude null emails, but every payment
-- carries one; rows without an email simply won't be onboarded.)
do $$ begin
    alter table public.customers add constraint customers_client_email_key UNIQUE (client_id, email);
exception when duplicate_object then null; end $$;

create index if not exists customers_client_idx on public.customers (client_id);
create index if not exists customers_email_idx on public.customers (email);
create index if not exists customers_anchor_idx on public.customers (onboarding_anchor_at) where (onboarding_anchor_at is not null);


-- ── onboarding_log (per-touch claim + dedup ledger) ─────────────────────────
create table if not exists public.onboarding_log (
    id uuid not null default gen_random_uuid(),
    client_id uuid not null,
    customer_id uuid not null,
    anchor timestamp with time zone not null,
    touch integer not null,
    status text not null default 'sending',   -- sending | sent | failed | skipped | abandoned
    provider text,                            -- resend | ghl
    subject text,
    provider_message_id text,
    error text,
    sent_at timestamp with time zone default now(),
    created_at timestamp with time zone not null default now()
);

do $$ begin
    alter table public.onboarding_log add constraint onboarding_log_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.onboarding_log add constraint onboarding_log_client_id_fkey FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;
do $$ begin
    alter table public.onboarding_log add constraint onboarding_log_customer_id_fkey FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE;
exception when duplicate_object then null; end $$;

create unique index if not exists onboarding_log_cust_anchor_touch_uniq on public.onboarding_log (customer_id, anchor, touch);
create index if not exists onboarding_log_cust_idx on public.onboarding_log (customer_id);
create index if not exists onboarding_log_sent_idx on public.onboarding_log (sent_at desc);


-- ── events (light audit log) ────────────────────────────────────────────────
create table if not exists public.events (
    id uuid not null default gen_random_uuid(),
    client_id uuid,
    customer_id uuid,
    event_type text not null,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamp with time zone not null default now()
);

do $$ begin
    alter table public.events add constraint events_pkey PRIMARY KEY (id);
exception when duplicate_object then null; end $$;
create index if not exists events_type_time_idx on public.events (event_type, created_at desc);
create index if not exists events_customer_idx on public.events (customer_id);


-- ── reporting_onboarding (dashboard counters) ───────────────────────────────
create or replace view public.reporting_onboarding as
 SELECT ( SELECT count(*) FROM events WHERE event_type = 'onboarding_started') AS onboarded_total,
    ( SELECT count(*) FROM customers WHERE onboarding_anchor_at is not null) AS in_sequence,
    ( SELECT count(*) FROM onboarding_log WHERE status = 'sent') AS emails_sent_total,
    ( SELECT count(*) FROM events WHERE event_type = 'onboarding_started' AND created_at > (now() - '30 days'::interval)) AS onboarded_30d,
    ( SELECT count(*) FROM events WHERE event_type = 'onboarding_completed') AS completed_total,
    ( SELECT count(*) FROM customers WHERE unsubscribed = true) AS unsubscribed_total;


-- ── updated_at triggers ─────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists clients_updated_at on public.clients;
create trigger clients_updated_at before update on public.clients for each row execute function public.set_updated_at();
drop trigger if exists customers_updated_at on public.customers;
create trigger customers_updated_at before update on public.customers for each row execute function public.set_updated_at();


-- ── Row-Level Security (server uses service_role, bypasses RLS) ──────────────
alter table public.clients        enable row level security;
alter table public.customers      enable row level security;
alter table public.onboarding_log enable row level security;
alter table public.events         enable row level security;

-- ============================================================================
-- END. Insert a client row, point your payment webhook at the app, flip
-- onboarding_enabled = true, and the emails flow out on payment.
-- ============================================================================
