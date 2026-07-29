// Cookie-bound Supabase clients for request handling.
//
// The v1 app talked to Postgres exclusively through the service-role key, which
// bypasses Row Level Security entirely. That was fine for a single-tenant app
// with no login. It is NOT fine now: with multiple paying users, the service
// role would happily hand user A the rows belonging to user B.
//
// So: every request made on behalf of a signed-in user goes through the client
// below, which carries their session and is therefore subject to RLS. The
// service-role client (lib/supabase.js) is reserved for exactly two callers —
// the cron worker and the admin panel — both of which legitimately act across
// all tenants.

import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY env vars."
    );
  }
  return { url, key };
}

// For route handlers and server components.
export function getUserSupabase() {
  const { url, key } = env();
  const store = cookies();
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Components can't set cookies; middleware refreshes instead.
        }
      },
    },
    global: {
      // Next.js caches GETs made from route handlers even under
      // `dynamic = "force-dynamic"`, which silently froze every read in v1.
      fetch: (input, init = {}) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
}

// Resolve the caller's user + profile, or null when signed out.
export async function getSessionUser() {
  try {
    const supabase = getUserSupabase();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data: profile } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();
    return { user, profile, supabase };
  } catch {
    return null;
  }
}

// Standard 401 for API routes.
export function unauthorized() {
  return Response.json({ error: "Not signed in." }, { status: 401 });
}
