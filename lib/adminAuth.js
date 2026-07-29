// Admin session tokens.
//
// The admin panel is deliberately NOT a Supabase user — it's a single shared
// password at an unlinked URL, per the product decision. That means the cookie
// is the whole security boundary, so it's an HMAC-signed, expiring token rather
// than anything guessable or forgeable.
//
// Uses Web Crypto (not node:crypto) so the same code runs in Edge middleware
// and in Node route handlers without a second implementation.

const enc = new TextEncoder();

function secret() {
  // Prefer a dedicated signing secret; fall back to deriving from the password
  // so the panel still works if only ADMIN_PASSWORD is set.
  const s = process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD;
  if (!s) throw new Error("Missing ADMIN_SECRET / ADMIN_PASSWORD env var.");
  return s;
}

async function hmac(msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Comparison that doesn't leak position of the first differing byte.
export function timingSafeEqual(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function checkAdminPassword(candidate) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  return timingSafeEqual(candidate, expected);
}

export const ADMIN_COOKIE = "lt_admin";

export async function signAdminToken(ttlMs = 8 * 60 * 60 * 1000) {
  const exp = Date.now() + ttlMs;
  return `${exp}.${await hmac(String(exp))}`;
}

export async function verifyAdminToken(token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  try {
    return timingSafeEqual(sig, await hmac(exp));
  } catch {
    return false;
  }
}
