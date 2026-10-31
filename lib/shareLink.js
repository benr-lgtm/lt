// Share-link recognition, with no dependencies, so the browser can run the
// same check the server does.
//
// This lives apart from samsaraShare.js deliberately. That module is the
// network reader — CSRF bootstrap, GraphQL, cookie jars — and pulling it into
// the client bundle to answer "is this a valid link?" would ship all of it to
// every visitor. More importantly, validation that only exists on the server
// can only report a problem AFTER a save, which is how a mistyped link used to
// sit there looking accepted until the first check failed half an hour later.

// Anything that looks like a URL at all. Used to decide whether the user typed
// a truck number or pasted a link — deliberately loose, because a string that
// starts with http is never a truck number.
export function looksLikeShareUrl(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

/**
 * "https://cloud.samsara.com/o/18379/fleet/viewer/vGPccXwx1gfgFSCEYEiC"
 *   -> { orgId: "18379", token: "vGPccXwx1gfgFSCEYEiC", href }
 *
 * Null for anything else, including other telematics providers' links.
 */
export function parseShareUrl(url) {
  try {
    const u = new URL(String(url).trim());
    if (!/(^|\.)samsara\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/\/o\/(\d+)\/fleet\/viewer\/([A-Za-z0-9_-]+)/);
    if (!m) return null;
    return { orgId: m[1], token: m[2], href: u.href };
  } catch {
    return null;
  }
}

export function parseMotiveUrl(url) {
  try {
    const u = new URL(String(url).trim());
    if (u.hostname.toLowerCase() !== "tracking.gomotive.com") return null;
    const match = `${u.pathname}${u.hash}`.match(
      /\/share\/v\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i
    );
    if (!match) return null;
    return { uuid: match[1].toLowerCase(), href: u.href };
  } catch {
    return null;
  }
}

/**
 * Why a pasted link can't be used — phrased for the person who pasted it.
 * Null when the link is fine, or when the value isn't a link at all.
 *
 * The three cases are genuinely different problems with different fixes, and
 * collapsing them into one "invalid link" would leave the user guessing which
 * mistake they made.
 */
export function shareLinkProblem(value) {
  const s = String(value || "").trim();
  if (!s || !looksLikeShareUrl(s)) return null;
  if (parseShareUrl(s) || parseMotiveUrl(s)) return null;

  let host = "";
  try {
    host = new URL(s).hostname.replace(/^www\./, "");
  } catch {
    return "That doesn't look like a complete web address — check the link was copied in full.";
  }

  if (/(^|\.)samsara\.com$/i.test(host)) {
    // Right company, wrong page: usually the dashboard URL rather than the
    // share link, or a link truncated by copy-paste.
    return "That's a Samsara address, but not a Live Share link. Open the truck in Samsara, click Live Share, and copy the whole link — it looks like cloud.samsara.com/o/…/fleet/viewer/…";
  }
  if (host === "tracking.gomotive.com") {
    return "That is a Motive address, but not a share link. Copy the full Motive vehicle share URL.";
  }
  return `Only Samsara or Motive vehicle share links work right now — this one points at ${host}.`;
}
