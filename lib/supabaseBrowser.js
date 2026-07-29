"use client";

import { createBrowserClient } from "@supabase/ssr";

let cached = null;

// Browser-side client. Uses the ANON key and is fully governed by RLS, so it
// can only ever see the signed-in user's own rows.
export function getBrowserSupabase() {
  if (cached) return cached;
  cached = createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
  return cached;
}
