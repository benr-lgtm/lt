import { randomUUID } from "node:crypto";

const LEASE_MS = 5 * 60 * 1000;

export async function acquireCheckLease(supabase, loadId) {
  const token = randomUUID();
  const now = new Date();
  const { data, error } = await supabase.from("loads")
    .update({ check_lease_token: token, check_lease_until: new Date(now.getTime() + LEASE_MS).toISOString() })
    .eq("id", loadId)
    .is("deleted_at", null)
    .or(`check_lease_until.is.null,check_lease_until.lt.${now.toISOString()}`)
    .select("*")
    .maybeSingle();
  if (error) {
    console.error("Could not acquire check lease:", error.code, error.message);
    throw new Error("Could not claim this load for tracking. Check the database migration and server logs.");
  }
  return data ? { token, load: data } : null;
}

export async function releaseCheckLease(supabase, loadId, token) {
  const { error } = await supabase.from("loads")
    .update({ check_lease_token: null, check_lease_until: null })
    .eq("id", loadId)
    .eq("check_lease_token", token);
  if (error) {
    console.error("Could not release check lease:", error.code, error.message);
    throw new Error("Tracking finished, but its check lease could not be released.");
  }
}
