# TruckOn.site

A single-page app for dispatchers. For each load you enter an appointment and **one of two tracking sources**:

- a **truck #** — for trucks on a Samsara account you have an API token for, or
- a public **Samsara or Motive vehicle share link** — for trucks you *don't* have API access to.

The app tracks each load's ETA and **emails you if it slips past the deadline**.

- **Frontend + API:** Next.js on **Vercel**
- **Storage:** **Supabase** (Postgres)
- **Truck location (truck #):** **Samsara API** (read-only, one or more accounts)
- **Truck location (Live Share):** Samsara's public share endpoint, read server-side
- **Motive share links:** public Motive vehicle-share locations are read server-side
- **Route + ETA:** **OpenRouteService** `driving-hgv`, with dry-van
  height/weight restrictions; **Mapbox** is the first fallback and **Google
  Directions** is the final fallback (both use car routing)
- **Geocoding:** **Nominatim** → ORS → Google, best precision wins
- **Email:** **Resend**
- **Scheduler:** **Supabase `pg_cron`** calls `/api/check` every 2 minutes

The board saves edits automatically. **Track** enables scheduled checks and late
email alerts; **Update all now** runs a one-time check even when Track is off.
New rows start with Track off. Motion is based on reported vehicle speed or the
provider's movement state, and old readings are marked stale. Clearing a row
removes it from the active board and reports while retaining it in History.

Run [`supabase-tracking-migration.sql`](./supabase-tracking-migration.sql) in the
Supabase SQL editor to add the tracking toggle, motion fields, and safe
compaction function. Existing rows stay tracked; newly inserted rows default to
Track off.

Motive's public share endpoint is used read-only. Its web-share key is publicly
embedded in Motive's tracking client; `MOTIVE_WEB_SHARE_API_KEY` can override it
if Motive rotates that client key.

## How it works (hybrid)

Each row is tracked by whichever identifier it has:

**Truck # (API mode).** The app pulls that truck's latest GPS from Samsara (one
call per connected account), geocodes your pasted destination once, and gets a
truck-restricted route and ETA from ORS. If ORS is unavailable, Mapbox is tried,
then Google Directions. The fallback car routes cannot guarantee truck
restrictions. **Truck-# loads refresh every 5 minutes**. Read-only — nothing is
created in your Samsara.

**Live Share link (scrape mode).** For trucks on an account you can't get a token
for, paste the public `cloud.samsara.com/…/fleet/viewer/…` or
`tracking.gomotive.com/…/share/v/<uuid>` link. Their public endpoints provide
location and, when available, speed. The destination comes from the board's
address, not the share link.

Either way: if the ETA is past your deadline, the row turns **Late** and you get
**one** email.

### Multiple Samsara accounts
Have trucks split across two Samsara orgs? Put the first account's token in
`SAMSARA_API_TOKEN` and any others in `SAMSARA_API_TOKENS` (comma-separated). All
are queried and merged, so those trucks can be tracked by truck # too — no link
needed. If you can't get a token for the second account, use Live Share links for
those trucks instead.

## Setup (about 25 minutes)

### 1. Supabase (database)
1. Create a free project at [supabase.com](https://supabase.com).
2. **SQL Editor** → paste [`supabase-schema.sql`](./supabase-schema.sql) → Run.
3. **Project Settings → API**, copy:
   - **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
   - **service_role** key → `SUPABASE_SERVICE_ROLE_KEY` (secret; server-side only)

### 2. Samsara (truck locations)
1. In the Samsara dashboard: **Settings → API Tokens → Create API Token**.
2. Give it **read** access to **Vehicle Statistics** (GPS).
3. Copy the token → `SAMSARA_API_TOKEN`.
   *(EU orgs only: set `SAMSARA_BASE_URL=https://api.eu.samsara.com`.)*
4. Second account? Ask its admin for the same kind of read-only token and add it
   to `SAMSARA_API_TOKENS` (comma-separated). Can't get one? Skip this — you'll
   track those trucks with Live Share links instead (no setup needed).

**Important — truck numbers must match.** A "Truck #" you type must match the
vehicle's **Name** in Samsara (e.g. `3040`). The app ignores case, spaces, and a
leading `#`, so `#3040` and `3040` both work — but `3040` won't match a vehicle
named `Truck 3040`. (Live Share links don't need this — they carry their own
identity.)

Motive fleet numbers are also supported when the instance owner configures the
Motive API key as the server-only `MOTIVE_API` environment variable. Enter a
Motive truck as `Motive: 123` to choose that fleet explicitly; an unprefixed
number checks Samsara first, then Motive. TruckOn reads current locations from
Motive's `/v1/vehicle_locations` API. Motive's key must have read access to
vehicle locations. Never use a `NEXT_PUBLIC_` variable for this key.

### 3. Routing providers
1. Sign up for [OpenRouteService](https://openrouteservice.org/dev/#/signup)
   and set its API key as `ORS_API_KEY`. ORS is the primary truck-restricted
   router.
2. Set `MAPBOX_TOKEN` for the first fallback. Mapbox Directions includes
   100,000 requests/month in its free tier.
3. Optionally set `GOOGLE_MAPS_KEY` for the final fallback. Google bills per
   request after its free credit. Both fallback services use car routing and
   cannot guarantee truck restrictions.

### 4. Resend (email)
1. Sign up at [resend.com](https://resend.com) and create an **API key** →
   `RESEND_API_KEY`.
2. **Verify the `truckon.site` domain in Resend**, then set
   `RESEND_FROM` to `TruckOn <alerts@truckon.site>`.

> Domain verification is not optional once there is more than one user. The
> shared `onboarding@resend.dev` sender delivers **only** to the address the
> Resend account was registered with — every other recipient silently receives
> nothing, with no bounce and no error. `/api/health` warns if `RESEND_FROM`
> still points at `resend.dev`.

Alert recipients are configured per account in **Settings**, not by an env var.

### 5. Telegram (optional)
1. Create a bot with [@BotFather](https://t.me/BotFather) and add its token as
   `TELEGRAM_BOT_TOKEN` in Vercel Environment Variables.
2. Keep the token server-side; the webhook verification secret is derived from
   it automatically. `TELEGRAM_WEBHOOK_SECRET` is an optional override.
3. Ensure `NEXT_PUBLIC_APP_URL` is the deployed HTTPS app URL (it defaults to
   `https://truckon.site`), then redeploy.
4. In Supabase SQL Editor, run [`supabase-telegram-migration.sql`](./supabase-telegram-migration.sql).
5. In TruckOn **Settings**, choose **Connect Telegram**, open the generated bot
   link, and press **Start**. Use **Update all now** on the website or **Update
   all** in Telegram for one report per load. Reports are formatted in
   monospace and include motion, ETA status, location, and miles left. Late and
   arrival changes also send an immediate notification.

The app registers the Telegram webhook when you create the connection link. The
link expires after 15 minutes and can only be used once. If the bot token shown
in a local environment file or chat is exposed, revoke it with BotFather and
replace it in Vercel before reconnecting.

### 6. AI load import (optional)
1. Add `GROQ_API_KEY` to Vercel Environment Variables and redeploy.
2. On the board, choose **Paste load with AI**, paste the full dispatch message,
   and select **Read and add stops**. Each unique PU/DEL is added as a separate
   row; when one Load # line lists multiple IDs, only the first is used.
3. If you send the message directly to the connected Telegram bot, its stops are
   added to your board automatically. If missing, reply to the bot with a truck
   number or Samsara/Motive vehicle share URL to attach it to those stops. Use
   the bot's **Update all** reply button for a one-time report. New imported
   loads start with Track off; turn it on from the website to schedule checks.
   On the website, **Update all now** sends a one-time report even if Track is
   off.

### 7. Deploy to Vercel
1. Push this folder to a GitHub repo.
2. [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Add every variable from [`.env.example`](./.env.example) under **Environment
   Variables**:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
   | `SAMSARA_API_TOKEN` | optional — instance-owner fallback; users add their own in Settings |
   | `SAMSARA_API_TOKENS` | optional — other accounts' tokens, comma-separated |
   | `MOTIVE_API` | optional — Motive API key for typed Motive truck numbers |
   | `ORS_API_KEY` | OpenRouteService key — supplies the truck-legal route |
   | `MAPBOX_TOKEN` | Mapbox public token — supplies the speed along it |
   | `GOOGLE_MAPS_KEY` | optional — last-resort geocoder for messy addresses |
   | `RESEND_API_KEY` | Resend API key |
   | `RESEND_FROM` | `TruckOn <alerts@truckon.site>` (verified domain) |
   | `TELEGRAM_BOT_TOKEN` | optional — Telegram bot token, server-only |
   | `TELEGRAM_WEBHOOK_SECRET` | optional — random secret, 32+ characters |
   | `GROQ_API_KEY` | optional — Groq API key for AI load import |
   | `GROQ_MODEL` | optional — defaults to `openai/gpt-oss-20b` |
   | `GROQ_MODEL` | optional — defaults to `openai/gpt-oss-20b` |
   | `NEXT_PUBLIC_APP_URL` | public HTTPS URL for the deployed app |
   | `ENCRYPTION_KEY` | 64 hex chars — encrypts per-user Samsara tokens |
   | `CHECK_SECRET` | any long random string; the cron must send `?key=` this |
   | `ADMIN_PASSWORD` / `ADMIN_SECRET` | guard the hidden `/admin` panel |
   | `LATE_GRACE_MIN` | `0` |

4. **Deploy.** You'll get a URL like `https://load-tracker-xxx.vercel.app`.

> **Vercel Hobby is for personal, non-commercial use.** The moment TruckOn has
> paying customers you need Pro — a licensing limit, not a technical one.
> `CHECK_BATCH` (default 40) caps how many rows one sweep touches, which keeps
> each invocation inside the function time limit.

### 8. The scheduler (Supabase pg_cron)

The checker is driven from **inside Postgres**, not by an external pinger.
`cron.job` runs `public.run_due_checks()` every 2 minutes, which reads
`public.worker_config` and calls your `/api/check` URL via `pg_net`:

```sql
-- one row, holding the URL and secret the cron posts to
select * from public.worker_config;
-- the schedule itself
select jobid, schedule, jobname, active from cron.job;
```

Each sweep only touches rows whose `next_check_at` has come due, so firing
every 2 minutes is cheap — most ticks find nothing to do. The interval per row
is chosen from its slack: hours of buffer means a 3-hour cadence, a load running
tight is checked every 5 minutes.

> **Do not point an external pinger at `/api/check`.** The URL carries
> `CHECK_SECRET` in the query string, and a second caller would double the sweep
> rate — the one thing that actually consumes routing quota.

### 9. Uptime monitoring (optional, recommended)

You do **not** need an external pinger to keep the app awake. Vercel functions
are invoked on demand and never idle out, and the 2-minute cron keeps the
Supabase project active so it never hits the 7-day pause.

What is worth monitoring is the opposite problem: **the cron dying silently.**
If it stops, pages still serve, the table still renders, and nothing is being
tracked. `/api/health` is built to catch exactly that — it reports how long the
oldest overdue row has been waiting and returns **503** once that exceeds
`HEALTH_STALL_MINUTES` (default 15).

1. Sign up at [uptimerobot.com](https://uptimerobot.com) (free).
2. **Add New Monitor** → **HTTP(s)**.
3. URL: `https://truckon.site/api/health` — no secret in it, safe to monitor.
4. Interval: 5 minutes. Any non-2xx means either the database is unreachable
   (500) or tracking has stalled (503).

The same endpoint also reports missing environment variables and warns if
`RESEND_FROM` still carries an old brand name.

## Using it
1. Open your Vercel URL.
2. Deadlines are read in the **destination's local time**, detected automatically
   from each address — so type the appointment time exactly as it appears on the
   load. Alerts always go to the fixed `NOTIFY_EMAIL` address, so there's nothing
   to configure here.
3. **Fastest way — paste your dispatch notes.** Click **Paste loads**, paste one
   or many blocks like:
   ```
   🛑DEL: 07/20/26 0900 - Appt set
   LSC COMMUNICATIONS
   1600 N MAIN ST
   PONTIAC, IL 61764
   ```
   The app fills the **DEL/PU**, **date & time**, **destination**, and **notes**
   for each. It understands `Delivery`/`DEL`/`Pickup`/`PU`, `MM/DD/YY` and
   `MM-DD-YYYY` dates, and times like `0900`, `07:00 AM`, `2300`, `23:59`. If a
   block has no time (e.g. "straight", "Ready now"), it's set to 23:59 — adjust if
   needed. Then just add the **truck # or vehicle share link** to each row.
4. Or fill a row by hand: optional **notes**, the **truck # or vehicle share link**,
   the **destination** (skip if using a link), and the **DEL/PU date & time**.
5. Changes save automatically. Turn on **Track** for scheduled checks and late
   email alerts, or click **Update all now** for a one-time check.

Status meanings: **On time** (ETA before deadline), **Late** (ETA past it — one
email sent), **Check failed** (truck not found, address couldn't be located, or a
link expired — hover for detail), **—** (not checked yet).

## Run locally (optional)
```bash
npm install
cp .env.example .env.local   # fill in the values
npm run dev
```
Open http://localhost:3000.

## Notes & limits
- You get **one** email when a load flips to Late. If its ETA recovers to on-time
  and later goes late again, you get a fresh alert.
- Typed deadlines are interpreted in the **destination's local time zone**,
  detected automatically from the address (handles DST and Arizona correctly).
- **Troubleshooting:** visit `https://YOUR-APP.vercel.app/api/health` — it shows
  which env vars are set and whether the database is reachable. A 500 on save
  almost always means the Supabase env vars aren't set or `supabase-schema.sql`
  wasn't run yet.
- Editing a row's source, destination, deadline, or type re-checks it; changing the
  destination re-geocodes it.
- The check endpoint is protected by `CHECK_SECRET`; the in-app "Check now" button
  works because it's a same-site request.
- Live Share links can expire (you set an expiry when creating them). An expired
  link shows **Check failed** — repaste a fresh one.
- **Address accuracy.** When parsing pasted blocks, the app sends only the street
  + city/state/ZIP to the geocoder (it drops the company name and suite/dock
  codes), which is what strict geocoders like best. Mapbox resolves the large
  majority. If some messy addresses miss, set `GEOCODE_PROVIDER=google` with a
  `GOOGLE_MAPS_KEY` — Google is more forgiving of typos and extra text, and since
  geocoding runs once per load and is cached, the Google cost is negligible even
  though routing prefers ORS. With a Google key set, the app also falls back to
  Google automatically whenever Mapbox can't find an address. For directions,
  ORS is primary; Mapbox and then Google are tried if the prior provider fails
  or returns an implausible route. Fallback mileage is non-truck-legal.
- Want zero maps dependency later? The ETA math is isolated in `lib/maps.js`, so
  it can be swapped for Samsara-created routes without touching the rest.
