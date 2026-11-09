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

let nextClientKey = 0;

function clientKey() {
  nextClientKey += 1;
  return `load-row-${nextClientKey}`;
}

export function blankRow(position) {
  return {
    client_key: clientKey(),
    id: null,
    position,
    pending_delete: false,
    load_number: "",
    name: "",
    source: "",
    kind: "delivery",
    appt_at: "",
    deadline: "",
    alert_unlinked: false,
    destination: "",
    notes: "",
    tracking_enabled: false,
    alert_enabled: false,
    telegram_enabled: false,
    telegram_interval_minutes: 0,
    checkin_enabled: false,
    checkin_state: null,
    status: "unknown",
    eta_display: "",
    last_place: "",
    miles_left: null,
    motion: null,
    motion_updated_at: null,
    position_precision: null,
    truck_at: "",
    status_note: "",
    dest_tz: null,
    updated_at: null,
    next_check_at: null,
    dest_precision: null,
    eta_iso: null,
    arrived_at: null,
  };
}

export const rowEmpty = (r) =>
  !r.load_number && !r.name && !r.source && !r.destination && !r.deadline && !r.appt_at && !r.notes;

/**
 * Keep SPARE_ROWS blank rows below the last filled one.
 *
 * Start at MIN_ROWS (10). Fill row 11 (index 10) and the table becomes
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
  "motion",
  "motion_updated_at",
  "position_precision",
  "truck_at",
  "checkin_state",
  "dest_tz",
  "telegram_interval_minutes",
  "updated_at",
  "next_check_at",
  "dest_precision",
  // The raw instant, so the status cell can render the clock time and the date
  // on separate lines instead of parsing a pre-formatted string.
  "eta_iso",
  "arrived_at",
];

// Fields the user owns. Only ever written from a full rebuild.
const BLANKABLE = {
  checkin_state: null,
  dest_tz: null,
  miles_left: null,
  motion: null,
  motion_updated_at: null,
  updated_at: null,
  next_check_at: null,
  dest_precision: null,
  eta_iso: null,
  arrived_at: null,
};

/**
 * Apply ONLY server-owned fields onto the rows currently on screen.
 *
 * This is what the background poll uses, and it is the entire fix for rows
 * vanishing mid-typing. The poll previously called mergeRows(), which rebuilds
 * the table from the server's copy — discarding anything typed but not saved.
 *
 * Matching is by persistent row ID so locally compacted rows cannot inherit
 * another row's status while a save is in flight.
 */
export function applyServerFields(prev, loads) {
  const byId = new Map((loads || []).map((l) => [Number(l.id), l]));
  return prev.map((r) => {
    const l = r.id ? byId.get(Number(r.id)) : null;
    if (!l) return r;
    if (rowEmpty(r)) return { ...r, id: l.id };
    const next = { ...r, id: l.id };
    for (const k of SERVER_FIELDS) {
      if (k === "status") next[k] = l[k] || "unknown";
      else if (k === "telegram_interval_minutes") next[k] = Number(l[k]) || 0;
      else if (k in BLANKABLE) next[k] = l[k] ?? BLANKABLE[k];
      else next[k] = l[k] || "";
    }
    return next;
  });
}

export function applySavedRows(prev, loads, submittedRows) {
  const keyByPosition = new Map(
    submittedRows.map((row) => [row.position, row.client_key])
  );
  const savedByKey = new Map(
    (loads || [])
      .map((load) => [keyByPosition.get(load.position), load])
      .filter(([key]) => key)
  );
  return prev.map((row) => {
    const saved = savedByKey.get(row.client_key);
    if (!saved) return row;
    const next = { ...row, id: saved.id };
    if (rowEmpty(row)) return next;
    for (const field of SERVER_FIELDS) {
      if (field === "status") next[field] = saved[field] || "unknown";
      else if (field === "telegram_interval_minutes") next[field] = Number(saved[field]) || 0;
      else if (field in BLANKABLE) next[field] = saved[field] ?? BLANKABLE[field];
      else next[field] = saved[field] || "";
    }
    return next;
  });
}

// Full rebuild from the server's copy. Used on initial load, never on a poll.
export function mergeRows(loads, cap = MAX_ROWS) {
  const byPos = new Map((loads || []).map((l) => [l.position, l]));
  const maxPos = Math.max(-1, ...(loads || []).map((l) => l.position));
  const base = Array.from({ length: Math.max(MIN_ROWS, maxPos + 1) }, (_, i) => {
    const l = byPos.get(i);
    if (!l) return blankRow(i);
    return serverRow(l, i);
  });
  return withSpare(base, cap);
}

function serverRow(l, position, key = clientKey()) {
  return {
    client_key: key,
    id: l.id,
    position,
    load_number: l.load_number || "",
    name: l.name || "",
    source: l.samsara_url || l.truck_number || "",
    kind: l.kind || "delivery",
    appt_at: l.appt_at || l.deadline || "",
    deadline: l.deadline || "",
    alert_unlinked: !!l.alert_unlinked,
    destination: l.destination || "",
    notes: l.notes || "",
    tracking_enabled: l.tracking_enabled !== false,
    alert_enabled: l.alert_enabled !== false,
    telegram_enabled: !!l.telegram_enabled,
    telegram_interval_minutes: Number(l.telegram_interval_minutes) || 0,
    checkin_enabled: !!l.checkin_enabled,
    checkin_state: l.checkin_state || null,
    status: l.status || "unknown",
    eta_display: l.eta_display || "",
    last_place: l.last_place || "",
    miles_left: l.miles_left,
    motion: l.motion || null,
    motion_updated_at: l.motion_updated_at || null,
    position_precision: l.position_precision || null,
    truck_at: l.truck_at || "",
    status_note: l.status_note || "",
    dest_tz: l.dest_tz || null,
    updated_at: l.updated_at || null,
    next_check_at: l.next_check_at || null,
    dest_precision: l.dest_precision || null,
    eta_iso: l.eta_iso || null,
    arrived_at: l.arrived_at || null,
  };
}
