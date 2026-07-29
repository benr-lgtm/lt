// AES-256-GCM helpers for the per-user Samsara API token.
//
// These tokens grant read access to a carrier's live fleet positions, so they
// are never stored in plaintext. Encrypted at rest with ENCRYPTION_KEY and
// decrypted in-process only, immediately before use.

import crypto from "node:crypto";

function key() {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error("Missing ENCRYPTION_KEY env var.");
  // Accept either 64 hex chars or any passphrase (hashed to 32 bytes).
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("sha256").update(raw).digest();
}

export function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

export function decryptSecret(blob) {
  if (!blob) return null;
  try {
    const [v, ivB, tagB, ctB] = String(blob).split(".");
    if (v !== "v1") return null;
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key(),
      Buffer.from(ivB, "base64url")
    );
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ctB, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // A key rotation or tampered value lands here. Treat as "no token" rather
    // than throwing, so one bad profile can't break the whole sweep.
    return null;
  }
}
