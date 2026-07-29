import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { ADMIN_COOKIE, verifyAdminToken } from "./lib/adminAuth";

// Routes reachable without a signed-in user. Everything else redirects to /login.
// There is deliberately no /signup — accounts are created from the admin panel
// only, which removes bonus-farming as a threat entirely.
const PUBLIC_PATHS = ["/login", "/admin/login", "/api/health"];

function isPublic(pathname) {
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export async function middleware(req) {
  const { pathname } = req.nextUrl;
  let res = NextResponse.next({ request: { headers: req.headers } });

  // ---- admin area: separate credential, separate cookie ----
  if (pathname.startsWith("/admin") || pathname.startsWith("/api/admin")) {
    if (pathname === "/admin/login" || pathname === "/api/admin/login") return res;
    const ok = await verifyAdminToken(req.cookies.get(ADMIN_COOKIE)?.value);
    if (!ok) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "admin auth required" }, { status: 401 });
      }
      const url = req.nextUrl.clone();
      url.pathname = "/admin/login";
      url.search = "";
      return NextResponse.redirect(url);
    }
    return res;
  }

  // The cron endpoints authenticate with CHECK_SECRET, not a user session.
  if (pathname.startsWith("/api/check")) return res;

  // ---- user area ----
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) req.cookies.set(name, value);
          res = NextResponse.next({ request: { headers: req.headers } });
          for (const { name, value, options } of list) res.cookies.set(name, value, options);
        },
      },
    }
  );

  // Touching getUser() is what refreshes an expiring token and writes the
  // rotated cookie onto the response.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && !isPublic(pathname)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
