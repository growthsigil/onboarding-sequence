# Onboarding Sequence

**The moment a customer pays, send them everything they need to get started - automatically.**

A payment fires a webhook, and the customer instantly gets a warm welcome email
with your onboarding details (forms, kickoff call, portal, whatever you use),
followed by a couple of gentle nudges over their first week. **Every line is a
placeholder you customize to your business and service** - set it once and every
new customer is onboarded seamlessly.

```
  customer pays ──▶ welcome + onboarding details (instant)
                         │
                         ├── day 2 ──▶ "a couple of quick things" nudge
                         │
                         └── day 5 ──▶ "how's it going?" check-in
```

- **Instant welcome.** The day-0 email is sent by the payment webhook itself, so
  it lands seconds after they pay - not on the next cron run.
- **Placeholder-driven.** Ships with proven copy full of `{tokens}`
  (`{calendar_link}`, `{portal_link}`, `{onboarding_form_link}`, …). Fill in your
  details once; optional lines disappear cleanly when you leave a token blank.
- **Your sender, your way.** Send through **Resend** (simplest) or your existing
  **GoHighLevel** email.
- **Any payment source.** Trigger from **Stripe** or **GoHighLevel** out of the
  box, or POST to a manual endpoint from anything else.
- **In your voice (optional).** Add a Claude key and each email is rewritten in
  your brand voice, guided by the templates.
- **Compliant.** One-click unsubscribe link + `List-Unsubscribe` header on every
  email; onboards each customer once (subscription renewals never re-trigger it).
- **Multi-tenant.** Run it for several businesses from one deployment.

---

## Set it up - two ways

### Option A - Guided (let Claude do it with you) 🪄

Open this repo in **[Claude Code](https://claude.ai/code)** (New session → pick
your `onboarding-sequence` repo) and paste:

> **Read `SETUP.md` and set up Onboarding Sequence for me, one step at a time. Do
> every technical part you can (run the SQL, add my business row, wire the
> endpoints); for anything that needs a click - Vercel, Stripe, Resend,
> GoHighLevel - give me exact instructions and wait. Generate any secrets for me.
> Ask me for each key only when you need it. Start now.**

### Option B - Manual (follow the steps)

Do the numbered steps under **[Manual setup](#manual-setup)** below.

---

## How it works

| Part | File | What it does |
|------|------|--------------|
| **Trigger** | `src/app/api/webhook/stripe/route.ts`, `webhook/ghl/route.ts` | A payment arms the sequence and fires the welcome email immediately. |
| **Sequence** | `src/lib/onboarding.ts` | Builds each email from your templates/tokens and tracks the schedule. |
| **Delivery** | `src/lib/email.ts` | Sends via Resend or GoHighLevel. |
| **Follow-ups** | `src/app/api/cron/onboarding` | A daily tick sends the day-2 / day-5 touches. |

Data lives in four Supabase tables (`clients`, `customers`, `onboarding_log`,
`events`) - see `db/schema.sql`.

---

## Prerequisites

- **[Vercel](https://vercel.com)** - hosts it.
- **[Supabase](https://supabase.com)** - the database.
- **An email sender** - **[Resend](https://resend.com)** (recommended) *or*
  **[GoHighLevel](https://www.gohighlevel.com)** email.
- **A payment source** - **[Stripe](https://stripe.com)** or **GoHighLevel**.
- **[Anthropic](https://console.anthropic.com)** - *optional*, to write emails in
  your voice (templates are used otherwise).
- **Telegram** *(optional)* - a ping when a new customer starts onboarding.

---

<a name="manual-setup"></a>
## Manual setup

*(Option B - the same thing the guided prompt does with you.)*

### 1. Deploy to Vercel

Import this repo (Add New… → Project → Import). Next.js auto-detects. Deploy;
copy the production URL - you'll set it as `APP_URL`.

### 2. Create the database

Supabase → **SQL Editor** → paste all of [`db/schema.sql`](db/schema.sql) → Run.

### 3. Environment variables

In Vercel → Settings → Environment Variables (see [`.env.example`](.env.example)):

| Variable | Required | What it is |
|----------|:---:|------------|
| `SUPABASE_URL` | ✅ | Supabase → Settings → API → Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | Supabase → Settings → API → **service_role** key |
| `CRON_SECRET` | ✅ | Any long random string - gates the tick + manual endpoint |
| `APP_URL` | ✅ | Your deployed URL (builds the unsubscribe links) |
| `RESEND_API_KEY` | if using Resend | resend.com → API Keys |
| `GHL_WEBHOOK_SECRET` | if using GHL | Any long random string - verifies the GHL webhook |
| `STRIPE_WEBHOOK_SECRET` | if using Stripe | Stripe → Developers → Webhooks (`whsec_…`) |
| `ANTHROPIC_API_KEY` | optional | Voice-matched emails (templates used if unset) |
| `ONBOARDING_MODEL` | optional | Default `claude-sonnet-4-6` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional | New-customer pings |

Redeploy. Open `APP_URL` for the dashboard.

### 4. Add a client (a business to onboard for)

Send with Resend:

```sql
insert into public.clients (name, slug, email_provider, from_name, from_email, reply_to, onboarding_offsets)
values (
  'Acme Coaching', 'acme',
  'resend',
  'Alex at Acme',            -- from name
  'hello@acme.com',          -- a VERIFIED Resend sender on your domain
  'alex@acme.com',           -- optional reply-to
  '{0,2,5}'                  -- welcome now, nudge day 2, check-in day 5
);
```

Send with GoHighLevel instead? Set `email_provider = 'ghl'` and fill
`ghl_location_id` + `ghl_api_key` (a Private Integration Token with the
Conversations + Contacts scopes).

### 5. Customize your onboarding copy

Put your links and sign-off on `clients.onboarding_templates`. Only fill what you
use - any line whose token is blank is dropped automatically.

```sql
update public.clients set onboarding_templates = '{
  "sender": "Alex",
  "sender_title": "Founder",
  "service": "the 12-week program",
  "onboarding_form_link": "https://acme.com/welcome-form",
  "calendar_link": "https://calendly.com/acme/kickoff",
  "portal_link": "https://portal.acme.com",
  "resource_link": "https://acme.com/getting-started",
  "community_link": "https://community.acme.com",
  "support_email": "help@acme.com"
}'::jsonb
where slug = 'acme';
```

See **[Customizing the emails](#customizing)** for every token and how to replace
a whole email.

### 6. Connect your payment source

**Stripe** - Developers → Webhooks → Add endpoint:
`APP_URL/api/webhook/stripe?client=acme`. Subscribe to
`checkout.session.completed` (and `invoice.paid` for subscriptions). Copy the
signing secret into `STRIPE_WEBHOOK_SECRET`.

**GoHighLevel** - a workflow → **Webhook** action → `APP_URL/api/webhook/ghl`,
custom header `x-webhook-secret` = `GHL_WEBHOOK_SECRET`. Trigger: **Order Form
Submitted / Payment Received** (or a "paid" tag).

**Test it** (arms + sends the welcome to a real inbox):

```bash
curl -X POST "APP_URL/api/payment/received?key=YOUR_CRON_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"client":"acme","email":"you@yourdomain.com","full_name":"You","product":"The Program","force":true}'
```

### 7. Schedule the follow-ups

`vercel.json` runs `/api/cron/onboarding` daily. **Vercel Pro:** done. **Hobby:**
drive it from an external scheduler (Supabase pg_cron / cron-job.org) hitting
`APP_URL/api/cron/onboarding` with header `Authorization: Bearer YOUR_CRON_SECRET`.
*(The instant welcome doesn't depend on this - only the day-2/day-5 touches do.)*

### 8. Turn it on

```sql
update public.clients set onboarding_enabled = true, onboarding_enabled_at = now() where slug = 'acme';
```

It only onboards customers who pay **after** this moment.

---

<a name="customizing"></a>
## Customizing the emails

The three emails are **placeholder-token templates**. Set token values on
`clients.onboarding_templates`:

| Token | Fills from | Notes |
|-------|-----------|-------|
| `{first}` / `{name}` | the customer | first name / full name |
| `{business}` | `clients.name` | |
| `{amount}` / `{product}` | the payment | e.g. `$1,000` / the plan name |
| `{sender}` / `{sender_title}` | templates | your sign-off |
| `{service}` | templates | e.g. "the 12-week program" |
| `{onboarding_form_link}` | templates | intake form |
| `{calendar_link}` | templates | kickoff booking link |
| `{portal_link}` / `{login_link}` | templates | client portal / login |
| `{resource_link}` / `{community_link}` | templates | getting-started / community |
| `{support_email}` / `{support_phone}` | templates | support contact |
| `{unsubscribe_link}` | automatic | also added to the footer for you |

Any optional line wrapped in `[[if token]]…[[/if]]` disappears cleanly when that
token is empty - so you never ship a half-filled email.

**Replace a whole email.** Set `s1`/`t1` (subject/body for email #1), `s2`/`t2`,
`s3`/`t3` and that exact copy is sent (AI skipped for that touch):

```sql
update public.clients
set onboarding_templates = onboarding_templates || '{
  "s1": "Welcome to Acme, your first steps inside 🎉",
  "t1": "Hi {first},\n\nThanks for joining! Book your kickoff here: {calendar_link}\n\n{sender}"
}'::jsonb
where slug = 'acme';
```

**Change the schedule.** `onboarding_offsets` is the day offset of each email
(`0` = instant). `'{0,3,7,14}'` = welcome now, then day 3, 7, 14.

**Voice matching.** Add `ANTHROPIC_API_KEY` and fill `clients.voice_samples` +
`clients.business_context`; each non-overridden email is rewritten in your voice,
keeping your links.

---

## Endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `POST /api/webhook/stripe` | Stripe signature | Payment signal (Stripe) |
| `POST /api/webhook/ghl` | `x-webhook-secret` | Payment signal (GoHighLevel) |
| `POST /api/payment/received` | `?key=` / Bearer | Manually arm a customer (test/backfill) |
| `GET /api/cron/onboarding` | Bearer `CRON_SECRET` | The daily follow-up tick |
| `GET /api/unsubscribe` | signed token | One-click unsubscribe (in every footer) |

---

## Local development

```bash
npm install
cp .env.example .env.local
npm run dev
npm run typecheck
```

## License

MIT - see [LICENSE](LICENSE).
