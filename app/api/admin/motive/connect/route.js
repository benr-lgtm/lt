import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { motiveOAuthConfig } from "../../../../../lib/motiveOAuth";

export const runtime = "nodejs";

const STATE_COOKIE = "lt_motive_oauth_state";

export async function POST() {
  try {
    const { clientId, redirectUri } = motiveOAuthConfig();
    const callback = new URL(redirectUri);
    if (callback.protocol !== "https:" && callback.hostname !== "localhost") {
      return NextResponse.json({ error: "MOTIVE_REDIRECT_URI must use HTTPS." }, { status: 400 });
    }
    if (
      callback.pathname !== "/api/admin/motive/callback" ||
      callback.search ||
      callback.hash
    ) {
      return NextResponse.json(
        { error: "MOTIVE_REDIRECT_URI must point exactly to /api/admin/motive/callback." },
        { status: 400 }
      );
    }

    const state = randomBytes(32).toString("hex");
    const authorizeUrl = new URL("https://gomotive.com/oauth/authorize");
    authorizeUrl.searchParams.set("client_id", clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "companies.read locations.vehicle_locations_list");

    authorizeUrl.searchParams.set("state", state);
    const response = NextResponse.json({ authorizationUrl: authorizeUrl.toString() });
    response.cookies.set(STATE_COOKIE, state, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/admin/motive/callback",
      maxAge: 600,
    });
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error.message || "Could not start Motive authorization." },
      { status: 500 }
    );
  }
}
