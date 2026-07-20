// Reads the live ETA from a Samsara "Live Share" link for trucks we don't have
// API access to. The share page is JavaScript-rendered (position arrives over a
// socket, ETA computed in-browser), so we render it headless and read the text.
//
// Verified against a real share link: ETA shows as e.g. "6:15 AM CDT".

import puppeteerCore from "puppeteer-core";

// US timezone abbreviations -> UTC offset in minutes.
const TZ_OFFSETS = {
  EST: -300, EDT: -240, CST: -360, CDT: -300,
  MST: -420, MDT: -360, PST: -480, PDT: -420,
  AKST: -540, AKDT: -480, HST: -600, UTC: 0, GMT: 0,
};

function looksLikeShareUrl(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}
export { looksLikeShareUrl };

async function launchBrowser() {
  if (process.env.BROWSER_WS_ENDPOINT) {
    return puppeteerCore.connect({
      browserWSEndpoint: process.env.BROWSER_WS_ENDPOINT,
    });
  }
  if (process.env.LOCAL_CHROME_PATH) {
    return puppeteerCore.launch({
      executablePath: process.env.LOCAL_CHROME_PATH,
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  const chromium = (await import("@sparticuz/chromium")).default;
  return puppeteerCore.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: { width: 1280, height: 800 },
  });
}

// Scrape one share link. Returns { etaText, etaIso, destination } or throws.
export async function scrapeLiveShare(url, { timeoutMs = 25000 } = {}) {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    );
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    let etaText = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      etaText = await page.evaluate(() => {
        const m = document.body.innerText.match(
          /\b\d{1,2}:\d{2}\s?[AP]M\s?[A-Z]{2,4}\b/
        );
        return m ? m[0] : null;
      });
      if (etaText) break;
      await new Promise((r) => setTimeout(r, 1500));
    }

    const destination = await page.evaluate(() => {
      const lines = document.body.innerText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const i = lines.findIndex((x) => /^DESTINATION$/i.test(x));
      return i >= 0 ? lines[i + 1] || null : null;
    });

    if (!etaText) {
      throw new Error("ETA not on page (link expired or no live data yet).");
    }
    return { etaText, etaIso: parseEtaToIso(etaText), destination };
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
      try { browser.disconnect && browser.disconnect(); } catch (_) {}
    }
  }
}

// Interpret a datetime-local deadline ("2026-07-19T06:00") in the timezone the
// ETA text reports (e.g. the "CDT" in "6:15 AM CDT"), returning an absolute ISO.
// This makes link-load deadlines use the destination's local time.
export function parseDeadlineToIso(deadlineLocal, etaText) {
  if (!deadlineLocal) return null;
  const m = String(deadlineLocal).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, hh, mm] = m.map(Number);
  let offsetMin = 0;
  const tzm = etaText && etaText.match(/([A-Z]{2,4})\s*$/);
  if (tzm && TZ_OFFSETS[tzm[1].toUpperCase()] !== undefined) {
    offsetMin = TZ_OFFSETS[tzm[1].toUpperCase()];
  }
  const utcMs = Date.UTC(y, mo - 1, d, hh, mm) - offsetMin * 60000;
  return new Date(utcMs).toISOString();
}

// Turn "6:15 AM CDT" into an absolute ISO timestamp (next occurrence).
export function parseEtaToIso(etaText, now = new Date()) {
  const m = etaText.match(/(\d{1,2}):(\d{2})\s?([AP]M)\s?([A-Z]{2,4})/i);
  if (!m) return null;
  let [, hh, mm, ap, tz] = m;
  hh = parseInt(hh, 10);
  mm = parseInt(mm, 10);
  ap = ap.toUpperCase();
  tz = tz.toUpperCase();
  if (ap === "PM" && hh !== 12) hh += 12;
  if (ap === "AM" && hh === 12) hh = 0;
  const offsetMin = TZ_OFFSETS[tz];
  if (offsetMin === undefined) return null;
  const nowInTz = new Date(now.getTime() + offsetMin * 60000);
  const y = nowInTz.getUTCFullYear();
  const mo = nowInTz.getUTCMonth();
  const d = nowInTz.getUTCDate();
  let utcMs = Date.UTC(y, mo, d, hh, mm) - offsetMin * 60000;
  if (utcMs < now.getTime() - 6 * 3600000) utcMs += 24 * 3600000;
  return new Date(utcMs).toISOString();
}
