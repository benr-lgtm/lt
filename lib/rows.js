// Table row model: the rules for turning server rows into on-screen rows, and
// for merging server updates back in without destroying what the user is typing.
//
// Extracted from app/page.js so the merge behaviour can be tested directly. The
// bug that motivated this was silent and expensive: the background poll rebuilt
// the whole table from the server every 12 seconds, so half-entered rows simply
// vanished while the dispatcher was still filling them in.

// How many blank rows the table opens with. Rows are tall now (a four-line
// paste cell), so 15 empties was a lot of scrolling before anything useful.
export const MIN_ROWS = 10;
// How many spare rows to keep below the last filled one, so there is always
// somewhere to type without the table growing without bound.
export const SPARE_ROWS = 5;
// Hard ceiling on rows per account. An admin can lower it per profile
// (profiles.max_rows); this is the default and the value the UI falls back to
// before a profile has loaded.
export const MAX_ROWS = 100;

export function blankRow(position) {
  return {
    id: null,
    position,
    name: "",
    source: "",
    kind: "delivery",
    appt_at: "",
    deadline: "",
    alert_unlinked: false,
    destination: "",
    notes: "",
    alert_enabled: true,
    checkin_enabled: false,
    checkin_state: null,
    status: "unknown",
    eta_display: "",
    last_place: "",
    miles_left: null,
    position_precision: null,
    truck_at: "",
    status_note: "",
    dest_tz: null,
    updated_at: null,
    next_check_at: null,
    dest_precision: null,
    eta_iso: null,
  };
}

export const rowEmpty = (r) =>
  !r.name && !r.source && !r.destination && !r.deadline && !r.appt_at && !r.notes;

/**
 * Keep SPARE_ROWS blank rows below the last filled one.
 *
 * Start at MIN_ROWS (15). Fill row 11 (index 10) and the table becomes
 * 10 + 1 + 5 = 16 rows, so a 16th appears; fill the 16th and a 21st appears,
 * and so on — the user never has to ask for another row.
 *
 * `cap` stops the runway at the account's row limit. Without it the table would
 * keep offering blank rows past the point where the server will save them,
 * which reads as the app losing data rather than enforcing a limit. The cap
 * never truncates rows that already exist: if a row is filled beyond the cap
 * (an admin lowered the limit after the fact), it stays visible so it can be
 * seen and cleared rather than silently vanishing.
 */
export function withSpare(list, cap = MAX_ROWS) {
  let lastFilled = -1;
  list.forEach((r, i) => {
    if (!rowEmpty(r)) lastFilled = i;
  });
  const limit = Math.max(1, cap || MAX_ROWS);
  const wanted = Math.max(MIN_ROWS, lastFilled + 1 + SPARE_ROWS);
  const size = Math.max(Math.min(wanted, limit), lastFilled + 1);
  const next = [];
  for (let i = 0; i < size; i++) next.push(list[i] ? { ...list[i], position: i } : blankRow(i));
  return next;
}

// Fields the server owns. The user cannot type into any of these, so writing
// them into a row that is being edited is always safe.
export const SERVER_FIELDS = [
  "status",
  "status_note",
  "eta_display",
  "last_place",
  "miles_left",
  "position_precision",
  "truck_at",
  "checkin_state",
  "dest_tz",
  "updated_at",
  "next_check_at",
  "dest_precision",
  // The raw instant, so the status cell can render the clock time and the date
  // on separate lines instead of parsing a pre-formatted string.
  "eta_iso",
];

// Fields the user owns. Only ever written from a full rebuild.
const BLANKABLE = {
  checkin_state: null,
  dest_tz: null,
  miles_left: null,
  updated_at: null,
  next_check_at: null,
  dest_precision: null,
  eta_iso: null,
};

/**
 * Apply ONLY server-owned fields onto the rows currently on screen.
 *
 * This is what the background poll uses, and it is the entire fix for rows
 * vanishing mid-typing. The poll previously called mergeRows(), which rebuilds
 * the table from the server's copy — discarding anything typed but not saved.
 *
 * Matching is by `position`, not array index, so the local table can hold spare
 * rows the server has never seen without the two drifting out of alignment.
 */
export function applyServerFields(prev, loads) {
  const byPos = new Map((loads || []).map((l) => [l.position, l]));
  return prev.map((r) => {
    const l = byPos.get(r.position);
    if (!l) return r;
    const next = { ...r, id: l.id };
    for (const k of SERVER_FIELDS) {
      if (k === "status") next[k] = l[k] || "unknown";
      else if (k in BLANKABLE) next[k] = l[k] ?? BLANKABLE[k];
      else next[k] = l[k] || "";
    }
    return next;
  });
}

// Full rebuild from the server's copy. Correct on first load and immediately
// after a save (where the server's answer IS the truth) — never on a poll.
export function mergeRows(loads, cap = MAX_ROWS) {
  const byPos = new Map((loads || []).map((l) => [l.position, l]));
  const maxPos = Math.max(-1, ...(loads || []).map((l) => l.position));
  const base = Array.from({ length: Math.max(MIN_ROWS, maxPos + 1) }, (_, i) => {
    const l = byPos.get(i);
    if (!l) return blankRow(i);
    return {
      id: l.id,
      position: i,
      name: l.name || "",
      source: l.samsara_url || l.truck_number || "",
      kind: l.kind || "delivery",
      appt_at: l.appt_at || l.deadline || "",
      deadline: l.deadline || "",
      alert_unlinked: !!l.alert_unlinked,
      destination: l.destination || "",
      notes: l.notes || "",
      // Rows saved before this column existed come back undefined; treat that as
      // alerting so nobody's existing loads go quiet after the upgrade.
      alert_enabled: l.alert_enabled !== false,
      checkin_enabled: !!l.checkin_enabled,
      checkin_state: l.checkin_state || null,
      status: l.status || "unknown",
      eta_display: l.eta_display || "",
      last_place: l.last_place || "",
      miles_left: l.miles_left,
      position_precision: l.position_precision || null,
      truck_at: l.truck_at || "",
      status_note: l.status_note || "",
      dest_tz: l.dest_tz || null,
      updated_at: l.updated_at || null,
      next_check_at: l.next_check_at || null,
      dest_precision: l.dest_precision || null,
      eta_iso: l.eta_iso || null,
    };
  });
  return withSpare(base, cap);
}
