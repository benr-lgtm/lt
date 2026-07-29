import { debugShare } from "../../../../lib/samsaraShare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/admin/debug-share?url=<samsara live share link>
//
// Admin-only (middleware guards /api/admin/*). Runs the Samsara bootstrap from
// the server and reports what actually came back. Exists because the browser
// cannot reproduce this call — cookies are scoped across cloud.samsara.com and
// us4-ws.cloud.samsara.com, so a browser test says nothing useful about what
// our server will get.
export async function GET(req) {
  const url = new URL(req.url).searchParams.get("url");
  if (!url) {
    return Response.json(
      { error: "Pass ?url=<samsara share link>" },
      { status: 400 }
    );
  }
  try {
    return Response.json(await debugShare(url));
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
