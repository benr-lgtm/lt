import { getSupabase } from "../../../lib/supabase";
import { credit } from "../../../lib/billing";
import { allUsageToday } from "../../../lib/usage";
import { encryptSecret } from "../../../lib/crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Middleware has already verified the signed admin cookie for every /api/admin
// path, so these handlers can use the service-role client freely.

const MAX_USERS = parseInt(process.env.MAX_USERS || "3", 10);
const SIGNUP_BONUS_CENTS = parseInt(process.env.SIGNUP_BONUS_CENTS || "5000", 10);

export async function GET() {
  const supabase = getSupabase();
  try {
    const { data: profiles } = await supabase
      .from("profiles")
      .select("*")
      .order("created_at", { ascending: true });

    const { data: loads } = await supabase
      .from("loads")
      .select("user_id,status,charged_at,position_source,link_tier");

    const stats = new Map();
    for (const l of loads || []) {
      const s = stats.get(l.user_id) || { rows: 0, active: 0, paid: 0 };
      s.rows++;
      if (!["arrived", "unpaid"].includes(l.status)) s.active++;
      if (l.charged_at) s.paid++;
      stats.set(l.user_id, s);
    }

    // Health signal for the Samsara GraphQL path: if this drops, Samsara
    // changed something and link loads are degrading.
    const linkLoads = (loads || []).filter((l) => l.position_source);
    const tier1 = linkLoads.filter((l) => l.link_tier === 1).length;
    const graphqlHealth = linkLoads.length
      ? Math.round((tier1 / linkLoads.length) * 100)
      : null;

    return Response.json({
      users: (profiles || []).map((p) => ({
        ...p,
        samsara_token_enc: p.samsara_token_enc ? "set" : null,
        stats: stats.get(p.id) || { rows: 0, active: 0, paid: 0 },
      })),
      usage: await allUsageToday(),
      graphqlHealth,
      maxUsers: MAX_USERS,
    });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  const supabase = getSupabase();
  try {
    const body = await req.json();
    const { action } = body;

    if (action === "topup") {
      const cents = Math.round(Number(body.amount) * 100);
      if (!Number.isFinite(cents) || cents === 0) {
        return Response.json({ error: "Enter an amount." }, { status: 400 });
      }
      await credit(supabase, body.userId, cents, cents > 0 ? "topup" : "refund", body.note || null);

      // A top-up should revive rows that stalled for lack of funds, otherwise
      // the user has to re-save every row to get tracking going again.
      if (cents > 0) {
        await supabase
          .from("loads")
          .update({
            status: "unknown",
            status_note: null,
            next_check_at: new Date().toISOString(),
          })
          .eq("user_id", body.userId)
          .eq("status", "unpaid");
      }
      return Response.json({ ok: true });
    }

    if (action === "createUser") {
      const { count } = await supabase
        .from("profiles")
        .select("id", { count: "exact", head: true });
      if ((count ?? 0) >= MAX_USERS) {
        return Response.json(
          { error: `User cap reached (${MAX_USERS}). Raise MAX_USERS to add more.` },
          { status: 400 }
        );
      }
      const email = String(body.email || "").trim().toLowerCase();
      if (!email) return Response.json({ error: "Email required." }, { status: 400 });

      const password = body.password || crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      const { data, error } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // invite-only, so skip the confirmation round-trip
      });
      if (error) return Response.json({ error: error.message }, { status: 400 });

      // The on_auth_user_created trigger already wrote the profile and the
      // signup bonus; return the password once so it can be handed over.
      return Response.json({
        ok: true,
        userId: data.user?.id,
        email,
        password,
        bonus: SIGNUP_BONUS_CENTS / 100,
      });
    }

    if (action === "setMaxRows") {
      await supabase
        .from("profiles")
        .update({ max_rows: Math.max(0, parseInt(body.maxRows, 10) || 0) })
        .eq("id", body.userId);
      return Response.json({ ok: true });
    }

    if (action === "setSamsaraToken") {
      const enc = body.token ? encryptSecret(body.token) : null;
      await supabase.from("profiles").update({ samsara_token_enc: enc }).eq("id", body.userId);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
