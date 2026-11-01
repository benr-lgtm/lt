import { getSupabase } from "./supabase";
import { decryptSecret, encryptSecret } from "./crypto";

const TOKEN_URL = "https://api.gomotive.com/oauth/token";
const REFRESH_EARLY_MS = 2 * 60 * 1000;

let refreshInFlight = null;

export function motiveOAuthConfigured() {
  return !!(
    process.env.MOTIVE_CLIENT_ID?.trim() &&
    process.env.MOTIVE_CLIENT_SECRET?.trim() &&
    process.env.MOTIVE_REDIRECT_URI?.trim()
  );
}

export function motiveOAuthConfig() {
  const clientId = process.env.MOTIVE_CLIENT_ID?.trim();
  const clientSecret = process.env.MOTIVE_CLIENT_SECRET?.trim();
  const redirectUri = process.env.MOTIVE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Set MOTIVE_CLIENT_ID, MOTIVE_CLIENT_SECRET, and MOTIVE_REDIRECT_URI in Vercel."
    );
  }
  return { clientId, clientSecret, redirectUri };
}

export async function exchangeMotiveCode(code) {
  const { clientId, clientSecret, redirectUri } = motiveOAuthConfig();
  const tokens = await requestTokens({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });
  if (!tokens.refresh_token) {
    throw new Error("Motive did not issue a refresh token; the connection cannot be kept active.");
  }
  return tokens;
}

export async function verifyMotiveAccessToken(accessToken) {
  const url = new URL("https://api.gomotive.com/v1/vehicle_locations");
  url.searchParams.set("per_page", "1");
  url.searchParams.set("page_no", "1");
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: "Bearer " + accessToken },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "Motive authorized the app, but vehicle locations were denied. Check that the app has Locations → Vehicles with Current Location and Current Driver → Read permission."
    );
  }
  if (!response.ok) {
    throw new Error(`Motive location API verification failed (${response.status}).`);
  }
  await response.json();
}

export async function saveMotiveTokens(tokens) {
  const supabase = getSupabase();
  const now = new Date();
  const expiresIn = Number(tokens.expires_in);
  if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Motive returned an incomplete OAuth token response.");
  }
  const accessTokenEnc = encryptSecret(tokens.access_token);
  const refreshTokenEnc = encryptSecret(tokens.refresh_token);
  if (!accessTokenEnc || !refreshTokenEnc) {
    throw new Error("Could not encrypt the Motive tokens.");
  }
  const { error } = await supabase.from("motive_oauth_tokens").upsert(
    {
      id: "shared",
      access_token_enc: accessTokenEnc,
      refresh_token_enc: refreshTokenEnc,
      token_expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
      authorized_at: now.toISOString(),
      updated_at: now.toISOString(),
    },
    { onConflict: "id" }
  );
  if (error) {
    if (error.code === "42P01") {
      throw new Error("Motive token table is missing. Run supabase-motive-oauth-migration.sql in Supabase first.");
    }
    throw error;
  }
}

export async function getMotiveAccessToken({ forceRefresh = false } = {}) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = refreshStoredToken(forceRefresh);
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

async function refreshStoredToken(forceRefresh) {
  if (!motiveOAuthConfigured()) {
    throw new Error(
      "Motive OAuth is not configured. Set MOTIVE_CLIENT_ID, MOTIVE_CLIENT_SECRET, and MOTIVE_REDIRECT_URI in Vercel."
    );
  }
  const supabase = getSupabase();
  const { data: row, error } = await supabase
    .from("motive_oauth_tokens")
    .select("access_token_enc,refresh_token_enc,token_expires_at")
    .eq("id", "shared")
    .maybeSingle();
  if (error) {
    if (error.code === "42P01") {
      throw new Error("Motive token table is missing. Run supabase-motive-oauth-migration.sql in Supabase first.");
    }
    throw error;
  }
  if (!row) {
    throw new Error("Motive is not connected yet. Open /admin and choose Connect Motive.");
  }

  const accessToken = decryptSecret(row.access_token_enc);
  const refreshToken = decryptSecret(row.refresh_token_enc);
  if (!accessToken || !refreshToken) {
    throw new Error("Stored Motive authorization could not be decrypted. Check ENCRYPTION_KEY, then reconnect Motive.");
  }
  const expiresAt = Date.parse(row.token_expires_at || "");
  if (
    !forceRefresh &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() + REFRESH_EARLY_MS
  ) {
    return accessToken;
  }

  const { clientId, clientSecret } = motiveOAuthConfig();
  const tokens = await requestTokens({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const nextTokens = {
    ...tokens,
    refresh_token: tokens.refresh_token || refreshToken,
  };
  const expiresIn = Number(nextTokens.expires_in);
  if (!nextTokens.access_token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Motive returned an incomplete refreshed-token response.");
  }
  const accessTokenEnc = encryptSecret(nextTokens.access_token);
  const refreshTokenEnc = encryptSecret(nextTokens.refresh_token);
  if (!accessTokenEnc || !refreshTokenEnc) {
    throw new Error("Could not encrypt refreshed Motive tokens.");
  }
  const { error: updateError } = await supabase
    .from("motive_oauth_tokens")
    .update({
      access_token_enc: accessTokenEnc,
      refresh_token_enc: refreshTokenEnc,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", "shared");
  if (updateError) throw updateError;
  return nextTokens.access_token;
}

async function requestTokens(params) {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(params),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`Motive OAuth token exchange failed (${response.status}). Check the client credentials and redirect URI.`);
  }
  if (!result || typeof result !== "object") {
    throw new Error("Motive OAuth returned an invalid token response.");
  }
  return result;
}
