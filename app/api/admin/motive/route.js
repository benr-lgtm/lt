import { NextResponse } from "next/server";
import { getSupabase } from "../../../../lib/supabase";
import { motiveOAuthConfigured } from "../../../../lib/motiveOAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await getSupabase()
    .from("motive_oauth_tokens")
    .select("authorized_at,token_expires_at")
    .eq("id", "shared")
    .maybeSingle();

  if (error && error.code !== "42P01") {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    configured: motiveOAuthConfigured(),
    connected: !!data,
    migrationRequired: error?.code === "42P01",
    authorizedAt: data?.authorized_at || null,
    tokenExpiresAt: data?.token_expires_at || null,
  });
}

export async function DELETE() {
  const { error } = await getSupabase()
    .from("motive_oauth_tokens")
    .delete()
    .eq("id", "shared");
  if (error) {
    if (error.code === "42P01") {
      return NextResponse.json({ error: "Run supabase-motive-oauth-migration.sql first." }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
