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
  const range = str.match(
    /\b(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:-|to)\s*\d{1,2}:\d{2}\s*(am|pm)\b/i
  );
  if (range) return build(+range[1], +range[2], range[3] || range[4]);
  let m = str.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (m) return build(+m[1], +m[2], m[3]);
  m = str.match(/\b(\d{3,4})\b\s*(am|pm)?/i); // military e.g. 0900, 2300
  if (m) {
    const num = m[1];
    const h = parseInt(num.slice(0, num.length - 2), 10);
    const mi = parseInt(num.slice(-2), 10);
    return build(h, mi, m[2]);
  }
  m = str.match(/\b(\d{1,2})\s*(am|pm)\b/i); // "12 PM"
  if (m) return build(+m[1], 0, m[2]);
  return null;
}
function nowParts() {
  const d = new Date();
  return { h: d.getHours(), m: d.getMinutes() };
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
// The unit designator must be followed by an identifier, not a street name.
const DETAIL_RE = /\b(?:suite|ste|unit|dock|door|bldg|building|block|floor|fl|rm|room|apt|dept)\b\s*(?:#\s*[\w-]+|(?:\d[\w-]*|[A-Za-z])\b)/i;

function cleanStreet(s) {
  return s
    .replace(new RegExp(`${DETAIL_RE.source}.*$`, "i"), "")
    .replace(/#\s*[\w-]+/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/[,\s]+$/, "")
    .trim();
}

const STATE = "(?:AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)";
const CITY_RE = new RegExp(`^[A-Za-z][A-Za-z .'-]*,?\\s+${STATE}\\.?\\s*(?:\\d{5}(?:-\\d{4})?)?\\s*$`, "i");
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
const STREET_RE = /^(?:address\s*:\s*)?\d+[A-Za-z]?(?:-\d+)?\s+[A-Za-z0-9]/i;
const ROAD_RE = /^[A-Za-z0-9][A-Za-z0-9 .'-]*\b(?:street|st|road|rd|drive|dr|avenue|ave|boulevard|blvd|lane|ln|parkway|pkwy|way|highway|hwy|circle|cir)\.?\s*$/i;

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
    const rest = s
      .replace(/^(delivery|del|pickup|pu)\b\s*:?\s*/i, "")
      .replace(/(\d)\s*:\s*(\d{2})\b/g, "$1:$2");
    const dm = rest.match(/(\d{1,2})[/\-](\d{1,2})(?:[/\-]((?:20\d{2}|\d{2}))(?![\d:]))?/);
    let appointmentAt = null;
    let deadline = null;
    let timeAssumed = false;
    let descriptor = "";
    if (dm) {
      let [, mo, da, yr] = dm;
      yr = yr || String(new Date().getFullYear());
      if (yr.length === 2) yr = "20" + yr;
      const after = rest.slice(dm.index + dm[0].length);
      const t = parseTime(after) || (/\bready\s*now\b|\basap\b/i.test(after) ? nowParts() : null);
      if (!t) {
        timeAssumed = true;
      } else {
        appointmentAt = `${yr}-${pad(+mo)}-${pad(+da)}T${pad(t.h)}:${pad(t.m)}`;
        deadline = appointmentAt;
        const window = after.match(/^\s*[-–—]?\s*(?:\d{1,2}:\d{2}|\d{3,4})\s*(?:am|pm)?\s*(?:-|–|—|to)\s*((?:\d{1,2}:\d{2}|\d{3,4})\s*(?:am|pm)?)/i);
        const end = window ? parseTime(window[1]) : null;
        if (end && (end.h * 60 + end.m) >= (t.h * 60 + t.m)) {
          deadline = `${yr}-${pad(+mo)}-${pad(+da)}T${pad(end.h)}:${pad(end.m)}`;
        }
      }
      // leftover words (e.g. "Appt set", "straight", "Ready now")
      descriptor = after
        .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)?\s*(?:-|to)\s*\d{1,2}:\d{2}\s*(?:am|pm)?/i, "")
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
    let addressVerified = false;
    let roadPresent = false;
    const addressDetails = [];
    const noteParts = [];
    let cityIdx = -1;
    for (let j = body.length - 1; j >= 0; j--) {
      if (CITY_RE.test(body[j])) {
        cityIdx = j;
        break;
      }
    }
    if (cityIdx >= 0) {
      const zipIdx = ZIP_RE.test(body[cityIdx + 1] || "") ? cityIdx + 1 : -1;
      const cityLine = [body[cityIdx].replace(/[,\s]+$/, ""), zipIdx >= 0 ? body[zipIdx] : ""].filter(Boolean).join(" ");
      let streetIdx = -1;
      for (let j = cityIdx - 1; j >= 0; j--) {
        if (STREET_RE.test(body[j])) {
          streetIdx = j;
          break;
        }
      }
      if (streetIdx < 0 && ROAD_RE.test(body[cityIdx - 1] || "")) streetIdx = cityIdx - 1;
      const street = streetIdx >= 0 ? cleanStreet(body[streetIdx].replace(/^address\s*:\s*/i, "")) : "";
      destination = [street, cityLine].filter(Boolean).join(", ");
      addressVerified = !!street && STREET_RE.test(street);
      roadPresent = !!street;
      for (let j = 0; j < body.length; j++) {
        if (j !== cityIdx && j !== streetIdx && j !== zipIdx) {
          noteParts.push(body[j]);
          if (DETAIL_RE.test(body[j])) addressDetails.push(body[j]);
        }
      }
      if (streetIdx >= 0) {
        const detail = body[streetIdx].match(DETAIL_RE);
        if (detail) addressDetails.push(detail[0]);
      }
    } else {
      // couldn't find a city line — keep the block as the destination guess
      destination = body.join(", ") || null;
    }

    if (descriptor) noteParts.push(descriptor);
    const notes = noteParts.join(" · ").slice(0, 120);

    if (deadline || destination) {
      loads.push({ kind, appointmentAt, deadline, destination, notes, timeAssumed, addressVerified, roadPresent, addressDetails });
    }
  }
  return loads;
}
