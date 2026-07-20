import { createClient } from "@supabase/supabase-js";

// Server-side Supabase client using the service-role key.
// Never import this into client components.
let cached = null;

export function getSupabase() {
  if (cached) return cached;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars."
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      // Next.js patches the global fetch and CACHES GET requests made from
      // route handlers (even with `dynamic = "force-dynamic"`). That froze
      // every Supabase read as an empty result from the first deploy, while
      // writes (POST) went through — rows saved but the table always loaded
      // blank. `cache: "no-store"` makes every Supabase request bypass the
      // Next.js Data Cache entirely.
      fetch: (input, init = {}) =>
        fetch(input, { ...init, cache: "no-store" }),
    },
  });
  return cached;
}
