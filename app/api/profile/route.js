import { getSessionUser, unauthorized } from "../../../lib/supabaseServer";
import { getSupabase } from "../../../lib/supabase";
import { encryptSecret } from "../../../lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { profile } = session;
  return Response.json({ profile: publicProfile(profile) });
}

// PUT /api/profile — the user's own contact details and optional Samsara token.
export async function PUT(req) {
  const session = await getSessionUser();
  if (!session) return unauthorized();
  const { supabase, user } = session;

  try {
    const body = await req.json();

    const notify_email = String(body.notify_email || "").trim();
    if (!notify_email) {
      return Response.json({ error: "A notification email is required." }, { status: 400 });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(notify_email)) {
      return Response.json({ error: "That doesn't look like a valid email." }, { status: 400 });
    }

    const patch = {
      notify_email,
      full_name: str(body.full_name),
      phone: str(body.phone),
      checkin_email_default: !!body.checkin_email_default,
    };

    // Update the ordinary fields through the user's own RLS-bound client.
    const { error } = await supabase.from("profiles").update(patch).eq("id", user.id);
    if (error) throw error;

    // The encrypted token is handled separately with the service role: the
    // column is deliberately not writable in a way that could leak ciphertext
    // back to the browser, and encryption must happen server-side.
    if (typeof body.samsara_token === "string" && body.samsara_token.trim()) {
      const enc = encryptSecret(body.samsara_token.trim());
      const { error: e2 } = await getSupabase()
        .from("profiles")
        .update({ samsara_token_enc: enc })
        .eq("id", user.id);
      if (e2) throw e2;
    }

    const { data: fresh } = await supabase
      .from("profiles")
      .select("*")
      .eq("id", user.id)
      .maybeSingle();

    return Response.json({ ok: true, profile: publicProfile(fresh) });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// Never return the ciphertext itself — only whether one is set.
function publicProfile(p) {
  if (!p) return null;
  const { samsara_token_enc, ...rest } = p;
  return { ...rest, has_samsara_token: !!samsara_token_enc };
}

function str(v) {
  const s = String(v ?? "").trim();
  return s || null;
}
