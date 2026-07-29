// Provider usage accounting and hard spend caps.
//
// Two jobs:
//   1. Count every outbound provider call in Postgres (api_usage), so the admin
//      panel can show real numbers and so caps survive across serverless
//      instances — an in-memory counter would reset on every cold start.
//   2. Refuse to make a call once that provider is over its daily cap.
//
// The cap that actually matters is Mapbox: it's the only provider with a card
// on file. ORS and Nominatim rate-limit rather than bill, so their caps exist
// to keep us clear of *their* limiter (avoiding 429 storms), not to save money.

import { getSupabase } from "./supabase";

const CAPS = {
  // Keep clear of ORS's real 2,000/day so we never trip their limiter.
  ors: int(process.env.ORS_DAILY_CAP, 1800),
  // The only provider that can cost money. Deliberately tight: normal usage is
  // ~400/month, so 200/day is ~15x headroom and still caps a runaway loop at ~$0.
  mapbox: int(process.env.MAPBOX_DAILY_CAP, 200),
  nominatim: int(process.env.NOMINATIM_DAILY_CAP, 1000),
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
