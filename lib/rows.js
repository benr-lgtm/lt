// Table row model: the rules for turning server rows into on-screen rows, and
// for merging server updates back in without destroying what the user is typing.
//
// Extracted from app/page.js so the merge behaviour can be tested directly. The
// bug that motivated this was silent and expensive: the background poll rebuilt
// the whole table from the server every 12 seconds, so half-entered rows simply
// vanished while the dispatcher was still filling them in.

export const MIN_ROWS = 15;
export const SPARE_ROWS = 5;

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
  };
}

export const rowEmpty = (r) =>
  !r.name && !r.source && !r.destination && !r.deadline && !r.appt_at && !r.notes;

// Keep a few blank rows below the last filled one so there is always somewhere
// to type, without growing the table without bound.
export function withSpare(list) {
  let lastFilled = -1;
  list.forEach((r, i) => {
    if (!rowEmpty(r)) lastFilled = i;
  });
  const size = Math.max(MIN_ROWS, lastFilled + 1 + SPARE_ROWS);
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
];

// Fields the user owns. Only ever written from a full rebuild.
const BLANKABLE = { checkin_state: null, dest_tz: null, miles_left: null };

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
export function mergeRows(loads) {
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
    };
  });
  return withSpare(base);
}
