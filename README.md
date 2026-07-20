# Load Tracker

A single-page app for dispatchers. For each load you enter a **deadline** plus
**one of two things**:

- a **truck #** — for trucks on a Samsara account you have an API token for, or
- a pasted **Live Share link** — for trucks you *don't* have API access to.

The app tracks each load's ETA and **emails you if it slips past the deadline**.

- **Frontend + API:** Next.js on **Vercel**
- **Storage:** **Supabase** (Postgres)
- **Truck location (truck #):** **Samsara API** (read-only, one or more accounts)
- **ETA math (truck #):** **Mapbox** (free tier) — or Google, your choice
- **ETA (Live Share link):** read directly off the public Samsara page (headless)
- **Email:** **Resend**
- **Scheduler:** **UptimeRobot** pings the check endpoint every 5 minutes

## How it works (hybrid)

Each row is tracked by whichever identifier it has:

**Truck # (API mode).** The app pulls that truck's latest GPS from Samsara (one
call per connected account), geocodes your pasted destination once, and asks
Mapbox for the live-traffic drive time. ETA = now + drive time. Fast, so **all
truck-# loads refresh every 5 minutes**. Read-only — nothing is created in your
Samsara.

**Live Share link (scrape mode).** For trucks on an account you can't get a token
for, paste the public `cloud.samsara.com/…/fleet/viewer/…` link. The app renders
that page headless and reads Samsara's own ETA off it. This is heavier, so
link-based loads refresh a **few per check** (`CHECK_BATCH_LINKS`, default 2).
The destination is already baked into the link, so you leave that column blank.

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

### 3. Mapbox (ETA math)
1. Sign up free at [mapbox.com](https://account.mapbox.com).
2. Copy your **default public token** → `MAPBOX_TOKEN`.
3. Leave `MAPS_PROVIDER=mapbox`.

Mapbox's free tier includes ~100,000 Directions and ~100,000 Geocoding requests
per month. Geocoding happens **once per load** (then it's cached), and ETAs are
only computed for loads you've filled in — so at a normal fleet size this stays
free. *(Prefer Google? Set `MAPS_PROVIDER=google` and `GOOGLE_MAPS_KEY`. Note
Google bills per request after its free credit.)*

### 4. Resend (email)
1. Sign up at [resend.com](https://resend.com) **with the address you want alerts
   sent to** (e.g. `dispatch@stltruckers.com`), and create an **API key** →
   `RESEND_API_KEY`.
2. **No domain verification needed.** Leave `RESEND_FROM` as the shared sender
   `STL Truckers Load Tracker <onboarding@resend.dev>`. Resend allows this sender
   to deliver **only to your Resend signup address** — which is exactly where you
   want alerts to go.
3. Set `NOTIFY_EMAIL` to that same address (`dispatch@stltruckers.com`). All
   alerts go there; there's no email box in the app.

> Later, if you want alerts sent to *other* addresses too, you'd verify a domain
> in Resend and change `RESEND_FROM` to something like `alerts@stltruckers.com`.

### 5. Deploy to Vercel
1. Push this folder to a GitHub repo.
2. [vercel.com](https://vercel.com) → **Add New → Project** → import the repo.
3. Add every variable from [`.env.example`](./.env.example) under **Environment
   Variables**:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key |
   | `SAMSARA_API_TOKEN` | Samsara API token (first account) |
   | `SAMSARA_API_TOKENS` | optional — other accounts' tokens, comma-separated |
   | `MAPS_PROVIDER` | `mapbox` |
   | `MAPBOX_TOKEN` | Mapbox public token |
   | `GEOCODE_PROVIDER` | optional — `google` for more forgiving address lookups |
   | `GOOGLE_MAPS_KEY` | optional — enables Google geocode (and auto-fallback) |
   | `RESEND_API_KEY` | Resend API key |
   | `RESEND_FROM` | `STL Truckers Load Tracker <onboarding@resend.dev>` |
   | `NOTIFY_EMAIL` | `dispatch@stltruckers.com` (your Resend signup address) |
   | `CHECK_SECRET` | any long random string |
   | `CHECK_BATCH_LINKS` | `2` (Live Share loads refreshed per check) |
   | `LATE_GRACE_MIN` | `0` |

4. **Deploy.** You'll get a URL like `https://load-tracker-xxx.vercel.app`.

> **Live Share links & Vercel Hobby.** Reading a pasted link renders a headless
> browser, which is heavy. On Vercel's free Hobby tier (10s function limit) keep
> `CHECK_BATCH_LINKS` at `1`–`2`; on Pro (60s) you can raise it. Truck-# loads
> aren't affected — they always all refresh. If you have many link-based loads,
> set `BROWSER_WS_ENDPOINT` to a hosted browser (e.g. Browserless) to lift the
> limit.

### 6. UptimeRobot (the scheduler)
1. Sign up at [uptimerobot.com](https://uptimerobot.com) (free).
2. **Add New Monitor** → **HTTP(s)**.
3. URL: `https://YOUR-APP.vercel.app/api/check?key=YOUR_CHECK_SECRET`
4. Interval: **5 minutes**. Save.

Done. Every 5 minutes it refreshes ETAs, and you get an email the moment a load
is projected to miss its deadline.

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
   needed. Then just add the **truck # or Live Share link** to each row.
4. Or fill a row by hand: optional **notes**, the **truck # or Live Share link**,
   the **destination** (skip if using a link), and the **DEL/PU date & time**.
5. Click **Save**. Statuses fill in on the next check, or click **Check now**.

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
  though ETAs stay on Mapbox's free tier. With a Google key set, the app also
  falls back to Google automatically whenever Mapbox can't find an address.
- Want zero maps dependency later? The ETA math is isolated in `lib/maps.js`, so
  it can be swapped for Samsara-created routes without touching the rest.
