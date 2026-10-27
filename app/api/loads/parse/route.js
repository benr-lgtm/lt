import { getSessionUser, unauthorized } from "../../../../lib/supabaseServer";
import { parseLoadMessage } from "../../../../lib/groq";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req) {
  const session = await getSessionUser();
  if (!session) return unauthorized();

  try {
    const body = await req.json();
    const stops = await parseLoadMessage(body.text);
    return Response.json({ stops });
  } catch (e) {
    return Response.json({ error: e.message || "Could not read the load information." }, { status: 400 });
  }
}