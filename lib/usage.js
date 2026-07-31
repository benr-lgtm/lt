// Provider usage accounting and hard spend caps.
//
// Two jobs:
//   1. Count every outbound provider call in Postgres (api_usage), so the admin
//      panel can show real numbers and so caps survive across serverless
//      instances — an in-memory counter would reset on every cold start.
//   2. Refuse to make a call once that provider is over its daily cap.
//
// The caps that actually matter are Mapbox and Google: they are the only
// providers with a card on file. ORS and Nominatim rate-limit rather than bill,
// so their caps exist to keep us clear of *their* limiter (avoiding 429
// storms), not to save money.

import { getSupabase } from "./supabase";

const CAPS = {
  // Keep clear of ORS's real 2,000/day so we never trip their limiter.
  ors: int(process.env.ORS_DAILY_CAP, 1800),
  // Mapbox is now the primary router, so the old 200/day would have throttled
  // normal operation. Mapbox Directions is free below 100,000 requests/month;
  // 3,000/day is 93,000/month, i.e. the cap binds BEFORE the free tier is
  // exhausted. Staying under it is therefore the same thing as staying at $0.
  // Real usage is ~270/day, so this is ~11x headroom and still stops a runaway
  // loop well short of the first billable request.
  mapbox: int(process.env.MAPBOX_DAILY_CAP, 3000),
  nominatim: int(process.env.NOMINATIM_DAILY_CAP, 1000),
  // Geocoding only, and cached per load, so this is reached a handful of times
  // a month at most. Google's free tier is 10,000 geocodes/month; 200/day keeps
  // a pathological retry loop inside it.
  google: int(process.env.GOOGLE_DAILY_CAP, 200),
};

function int(v, d) {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

export function capFor(provider) {
  return CAPS[provider] ?? Infinity;
}

// Atomic increment; returns the running total for today.
// Never throws — accounting must not be able to break a check.
export async function bumpUsage(provider, amount = 1) {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.rpc("bump_usage", {
      p_provider: provider,
      p_amount: amount,
    });
    if (error) throw error;
    return Number(data) || 0;
  } catch (e) {
    console.warn(`[usage] bump failed for ${provider}: ${e.message}`);
    return 0;
  }
}

export async function usageToday(provider) {
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("api_usage")
      .select("count")
      .eq("provider", provider)
      .eq("day", new Date().toISOString().slice(0, 10))
      .maybeSingle();
    return Number(data?.count) || 0;
  } catch {
    return 0;
  }
}

// True if we still have budget for one more call to `provider`.
export async function underCap(provider) {
  const cap = capFor(provider);
  if (!Number.isFinite(cap)) return true;
  return (await usageToday(provider)) < cap;
}

export async function allUsageToday() {
  try {
    const supabase = getSupabase();
    const { data } = await supabase
      .from("api_usage")
      .select("provider,count")
      .eq("day", new Date().toISOString().slice(0, 10));
    const out = {};
    for (const r of data || []) out[r.provider] = { used: Number(r.count) || 0, cap: capFor(r.provider) };
    return out;
  } catch {
    return {};
  }
}

// ---- Nominatim politeness ---------------------------------------------
// Their policy caps scheduled use at ~4 req/min and requires caching plus a
// real User-Agent. We cache geocodes per load in the DB, so live volume is
// already tiny; this just spaces out any burst within a single instance.
//
// Note: serverless means this is per-instance, not global. That's acceptable
// only because destination geocodes are cached and therefore rare — if that
// ever stops being true, this needs to move into Postgres.
let nominatimLast = 0;
export async function nominatimGate(minGapMs = 1100) {
  const wait = nominatimLast + minGapMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nominatimLast = Date.now();
}
