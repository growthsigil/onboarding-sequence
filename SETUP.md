# SETUP - guided walkthrough

**You (Claude) are setting up "Onboarding Sequence" for the user. Work through
this ONE STEP AT A TIME. Confirm each step before moving on.**

House rules:
- **Ask for one thing at a time.** Need a key? Ask for just that one, wait, continue.
- **Do every technical part you can.** Have a Supabase connector? Run the SQL
  yourself. Otherwise hand over the exact SQL to paste and wait for "done". You
  can `curl` the app's own endpoints to test - do that rather than making the user.
- **Generate the secrets** (long random strings) and show them; don't make the
  user invent them.
- **Hand off click-only steps** (Vercel import, Stripe/Resend/GHL dashboards)
  with precise, numbered instructions and wait.
- **Keep it human** - short messages, plain language.

First, ask two quick questions that shape the rest:
1. **How do you take payment?** → Stripe, or GoHighLevel.
2. **How should the emails send?** → Resend (simplest), or GoHighLevel email.

Checklist:
- [ ] 1. Vercel deploy (get the app URL)
- [ ] 2. Supabase project + run the schema
- [ ] 3. Email sender (Resend or GHL)
- [ ] 4. Environment variables
- [ ] 5. Add their business (a clients row)
- [ ] 6. Customize the onboarding copy (their links + sign-off)
- [ ] 7. Connect the payment source (Stripe or GHL)
- [ ] 8. Test with a real email
- [ ] 9. Schedule the follow-up tick
- [ ] 10. Turn it on

---

## Step 1 - Deploy to Vercel

1. **vercel.com → Add New… → Project → Import** this `onboarding-sequence` repo.
2. Next.js auto-detects - leave defaults. **Deploy** (fine without env vars yet).
3. Copy the **production URL** → this is `APP_URL`. **Ask the user for it.**

## Step 2 - Supabase

1. **supabase.com → New project** (name, region, DB password). Wait ~2 min.
2. **Settings → API** → **Project URL** (`SUPABASE_URL`) + **service_role** key
   (`SUPABASE_SERVICE_ROLE_KEY`). ⚠️ service_role is server-only. **Ask for both.**
3. Run `db/schema.sql` (via your Supabase tool, or have them paste it into SQL
   Editor → Run). Confirm the tables exist (`clients`, `customers`,
   `onboarding_log`, `events`).

## Step 3 - Email sender

**If Resend:** resend.com → **API Keys** → create one (`RESEND_API_KEY`). Then
**Domains** → add + verify their sending domain (so `from_email` can be
`hello@theirdomain.com`). For a quick test they can use `onboarding@resend.dev`
as the from address. **Ask for the API key.**

**If GoHighLevel email:** you'll use their GHL location token (collected in
Step 5); no separate email key needed.

## Step 4 - Environment variables

Set in Vercel → Settings → Environment Variables. Generate secrets yourself.

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | from Step 2 |
| `CRON_SECRET` | **generate** a random string |
| `APP_URL` | from Step 1 (needed for unsubscribe links) |
| `RESEND_API_KEY` | from Step 3 (if Resend) |
| `GHL_WEBHOOK_SECRET` | **generate** (if paying via GHL) |
| `STRIPE_WEBHOOK_SECRET` | from Step 7 (if paying via Stripe) - set it then |
| `ANTHROPIC_API_KEY` | **ask** (optional - voice-matched emails) |

Optional: `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (new-customer pings).
**Redeploy** after setting them.

## Step 5 - Add their business

Collect, one at a time: business **name**, a **slug**, and the send settings.

Resend:
```sql
insert into public.clients (name, slug, email_provider, from_name, from_email, reply_to, onboarding_offsets)
values ('BUSINESS','slug','resend','FROM NAME','hello@theirdomain.com','reply@theirdomain.com','{0,2,5}');
```

GoHighLevel email:
```sql
insert into public.clients (name, slug, email_provider, from_name, from_email, ghl_location_id, ghl_api_key, onboarding_offsets)
values ('BUSINESS','slug','ghl','FROM NAME','hello@theirdomain.com','GHL_LOCATION_ID','pit-GHL_TOKEN','{0,2,5}');
```

Leave `onboarding_enabled` off until Step 10.

## Step 6 - Customize the copy

This is the important one - the templates ship with `{tokens}` they fill in.
Collect their links (skip any they don't have; blank ones vanish from the email):
onboarding form, kickoff **calendar link**, **client portal / login**, a
**getting-started/resource** link, a **community** link, a **support email**, and
their **sign-off name + title**. Then:

```sql
update public.clients set onboarding_templates = '{
  "sender":"Alex","sender_title":"Founder","service":"the program",
  "onboarding_form_link":"","calendar_link":"","portal_link":"",
  "resource_link":"","community_link":"","support_email":""
}'::jsonb
where slug = 'slug';
```

Offer to preview: `curl` the manual endpoint (Step 8) to their own inbox so they
can read the real welcome email before going live. If they want different words,
set `s1`/`t1`, `s2`/`t2`, `s3`/`t3` (subject/body per email). To change timing,
edit `onboarding_offsets`.

## Step 7 - Connect the payment source

**Stripe:** Developers → Webhooks → **Add endpoint** →
`APP_URL/api/webhook/stripe?client=slug`. Events: `checkout.session.completed`
(and `invoice.paid` for subscriptions). Copy the **Signing secret** (`whsec_…`)
into `STRIPE_WEBHOOK_SECRET` in Vercel and **redeploy**.

**GoHighLevel:** a workflow → **Webhook** action → `APP_URL/api/webhook/ghl`,
custom header `x-webhook-secret` = `GHL_WEBHOOK_SECRET`. Trigger: **Order Form
Submitted / Payment Received** (or a "paid" tag). Publish it.

## Step 8 - Test with a real email

Send the welcome to a real inbox (`force:true` re-onboards even in testing):

```bash
curl -X POST "APP_URL/api/payment/received?key=<CRON_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"client":"slug","email":"THEIR@email.com","full_name":"First Last","product":"The Program","force":true}'
```

Confirm the email arrived and every link is right. Check the dashboard - "onboarded"
and "emails sent" should tick up. Then do a real end-to-end test payment if they can.

## Step 9 - Schedule the follow-up tick

`vercel.json` runs `/api/cron/onboarding` daily. **Pro:** done. **Hobby:** set up
an external scheduler (Supabase pg_cron / cron-job.org) hitting
`APP_URL/api/cron/onboarding` with header `Authorization: Bearer <CRON_SECRET>`.
Note: the instant welcome doesn't need this - only day-2/day-5 do.

## Step 10 - Turn it on

```sql
update public.clients set onboarding_enabled = true, onboarding_enabled_at = now() where slug = 'slug';
```

It only onboards customers who pay **after** this moment.

Wrap up - remind them:
- Edit copy/links anytime via `clients.onboarding_templates`; change timing via
  `onboarding_offsets`.
- Each customer is onboarded once; subscription renewals won't re-trigger it.
- Every email has a one-click unsubscribe; unsubscribes show on the dashboard.
