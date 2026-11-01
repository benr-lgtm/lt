import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  exchangeMotiveCode,
  saveMotiveTokens,
  verifyMotiveAccessToken,
} from "../../../../../lib/motiveOAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATE_COOKIE = "lt_motive_oauth_state";

export async function GET(request) {
  const url = new URL(request.url);
  const stateCookie = request.cookies.get(STATE_COOKIE)?.value || "";
  const stateQuery = url.searchParams.get("state") || "";
  const baseUrl = process.env.MOTIVE_REDIRECT_URI?.trim() || request.nextUrl.origin;
  const adminUrl = new URL("/admin", baseUrl);
  const clearCookie = (response) => {
    response.cookies.set(STATE_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/admin/motive/callback",
      maxAge: 0,
    });
    return response;
  };
  const redirectWithResult = (result, reason) => {
    adminUrl.searchParams.set("motive", result);
    if (reason) adminUrl.searchParams.set("reason", reason);
    return clearCookie(NextResponse.redirect(adminUrl));
  };

  if (!stateCookie || !safeEqual(stateCookie, stateQuery)) {
    return redirectWithResult("error", "Authorization state did not match. Try connecting again.");
  }
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return redirectWithResult(
      "error",
      providerError === "access_denied"
        ? "Motive access was declined."
        : "Motive could not authorize this connection."
    );
  }

  const code = url.searchParams.get("code");
  if (!code) return redirectWithResult("error", "Motive did not return an authorization code.");

  try {
    const tokens = await exchangeMotiveCode(code);
    await verifyMotiveAccessToken(tokens.access_token);
    await saveMotiveTokens(tokens);
    return redirectWithResult("connected");
  } catch (error) {
    console.error("Motive OAuth callback failed:", error.message);
    return redirectWithResult(
      "error",
      error.message || "Motive connection failed. Check the server logs."
    );
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
