import { checkAdminPassword, signAdminToken, ADMIN_COOKIE } from "../../../../lib/adminAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Deliberately slow-ish and unlinked from the app nav. The admin panel is a
// single shared password, so the only defences are the strength of that
// password and the fact nothing links here.
export async function POST(req) {
  const { password } = await req.json().catch(() => ({}));
  const ok = await checkAdminPassword(password);

  // Blunt throttle against online guessing.
  await new Promise((r) => setTimeout(r, ok ? 0 : 600));
  if (!ok) return Response.json({ error: "Incorrect password." }, { status: 401 });

  const token = await signAdminToken();
  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${8 * 60 * 60}${
      process.env.NODE_ENV === "production" ? "; Secure" : ""
    }`
  );
  return res;
}

export async function DELETE() {
  const res = Response.json({ ok: true });
  res.headers.append("Set-Cookie", `${ADMIN_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  return res;
}
