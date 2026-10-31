// Parse pasted load blocks like:
//
//   🛑DEL: 07/20/26 0900 - Appt set
//   LSC COMMUNICATIONS
//   1600 N MAIN ST
//   PONTIAC, IL 61764
//
// into { kind, deadline, destination, notes, timeAssumed }.
// A block starts at a DEL/PU/Delivery/Pickup line that also contains a date.

const SEP = /^[\s—–\-_=*·•]+$/; // separator / blank-ish lines

function stripLead(s) {
  return s.replace(/^[^A-Za-z0-9]+/, "");
}

function isHeader(line) {
  const s = stripLead(line);
  return (
    /^(delivery|del|pickup|pu)\b/i.test(s) &&
    /\d{1,2}[/\-]\d{1,2}(?:[/\-]\d{2,4})?/.test(line)
  );
}

function pad(n) {
  return String(n).padStart(2, "0");
}

// Extract HH:MM (24h) from the text after the date. Returns { h, m } or null.
function parseTime(str) {
  let m = str.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (m) return build(+m[1], +m[2], m[3]);
  m = str.match(/\b(\d{3,4})\b\s*(am|pm)?/i); // military e.g. 0900, 2300
  if (m) {
    const num = m[1];
    const h = parseInt(num.slice(0, num.length - 2), 10);
    const mi = parseInt(num.slice(-2), 10);
    return build(h, mi, m[2]);
  }
  return null;
}
function build(h, m, ap) {
  if (m > 59) return null;
  if (ap) {
    ap = ap.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  }
  if (h > 23 || h < 0) return null;
  return { h, m };
}

// Clean a street line for geocoding: drop suite/unit/dock/building tokens.
//
// The trailing \b on the keyword group is load-bearing. Without it, "fl" matched
// inside FLEET and "unit" inside UNITED, and the following [\w-]+ then ate the
// rest of the word — so "140 FLEET DR" geocoded as "140 DR", which Nominatim
// resolves to the town centre several miles from the actual dock. That is how a
// truck sitting at the door reported six miles out.
//
// The unit designator must also be FOLLOWED by an identifier to be dropped: a
// bare trailing "DR"/"ST" is a street suffix, not a suite number.
function cleanStreet(s) {
  return s
    .replace(
      /\b(?:suite|ste|unit|dock|door|bldg|building|floor|fl|rm|room|apt|dept)\b\.?\s*#?\s*[\w-]+/gi,
      ""
    )
    .replace(/#\s*[\w-]+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[,\s]+$/, "")
    .trim();
}

const CITY_RE = /,?\s*[A-Za-z.]{2,}\s*,?\s*[A-Za-z]{2}\.?\s+\d{5}(-\d{4})?\s*$/;
const STREET_HINT =
  /\b(st|street|ave|avenue|blvd|boulevard|rd|road|dr|drive|ln|lane|way|ct|court|pl|place|pkwy|parkway|hwy|highway|cir|circle|ter|terrace|pike|route|rte|loop|trl|trail)\b|^\d/i;

export function parseLoads(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const heads = [];
  lines.forEach((line, idx) => {
    if (isHeader(line)) heads.push(idx);
  });

  const loads = [];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i];
    const end = i + 1 < heads.length ? heads[i + 1] : lines.length;
    const headLine = lines[start];
    const s = stripLead(headLine);
    const kind = /^(pu|pickup)/i.test(s) ? "pickup" : "delivery";

    // date + time from the header line
    const rest = s.replace(/^(delivery|del|pickup|pu)\b\s*:?\s*/i, "");
    const dm = rest.match(/(\d{1,2})[/\-](\d{1,2})(?:[/\-](\d{2,4}))?/);
    let deadline = null;
    let timeAssumed = false;
    let descriptor = "";
    if (dm) {
      let [, mo, da, yr] = dm;
      yr = yr || String(new Date().getFullYear());
      if (yr.length === 2) yr = "20" + yr;
      const after = rest.slice(dm.index + dm[0].length);
      const t = parseTime(after);
      if (!t) {
        timeAssumed = true;
      } else {
        deadline = `${yr}-${pad(+mo)}-${pad(+da)}T${pad(t.h)}:${pad(t.m)}`;
      }
      // leftover words (e.g. "Appt set", "straight", "Ready now")
      descriptor = after
        .replace(/\b\d{1,2}:\d{2}\s*(am|pm)?/i, "")
        .replace(/\b\d{3,4}\b\s*(am|pm)?/i, "")
        .replace(/^[\s:\-–—]+/, "")
        .replace(/\s{2,}/g, " ")
        .trim();
    }

    // address block: non-empty, non-separator lines between headers
    const body = [];
    for (let j = start + 1; j < end; j++) {
      const l = lines[j].trim();
      if (l && !SEP.test(l)) body.push(l);
    }

    let destination = null;
    const noteParts = [];
    let cityIdx = -1;
    for (let j = body.length - 1; j >= 0; j--) {
      if (CITY_RE.test(body[j]) || /[A-Za-z]{2}\s+\d{5}(-\d{4})?\s*$/.test(body[j])) {
        cityIdx = j;
        break;
      }
    }
    if (cityIdx >= 0) {
      const cityLine = body[cityIdx];
      // street = nearest line above the city that looks like a street
      let streetIdx = -1;
      for (let j = cityIdx - 1; j >= 0; j--) {
        if (STREET_HINT.test(body[j])) {
          streetIdx = j;
          break;
        }
      }
      if (streetIdx === -1) streetIdx = cityIdx - 1;
      const street = streetIdx >= 0 ? cleanStreet(body[streetIdx]) : "";
      destination = [street, cityLine].filter(Boolean).join(", ");
      for (let j = 0; j < body.length; j++) {
        if (j !== cityIdx && j !== streetIdx) noteParts.push(body[j]);
      }
    } else {
      // couldn't find a city line — keep the block as the destination guess
      destination = body.join(", ") || null;
    }

    if (descriptor) noteParts.push(descriptor);
    const notes = noteParts.join(" · ").slice(0, 120);

    if (deadline || destination) {
      loads.push({ kind, deadline, destination, notes, timeAssumed });
    }
  }
  return loads;
}
