"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { parseLoads } from "../lib/parseLoads";
import { getBrowserSupabase } from "../lib/supabaseBrowser";
import Instructions from "./Instructions";
import Settings from "./Settings";
import Balance from "./Balance";
import ThemeToggle from "./ThemeToggle";
import {
  MIN_ROWS,
  MAX_ROWS,
  blankRow,
  rowEmpty,
  withSpare,
  mergeRows,
  applyServerFields,
} from "../lib/rows";
import { shareLinkProblem } from "../lib/shareLink";

// "America/Chicago" -> "CDT". Null until the destination has been geocoded,
// since the zone is derived from its coordinates.
function tzAbbr(timeZone, when) {
  if (!timeZone) return null;
  try {
    const at = when ? new Date(when.replace(" ", "T")) : new Date();
    const d = Number.isFinite(at.getTime()) ? at : new Date();
    return (
      new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "short" })
        .formatToParts(d)
        .find((p) => p.type === "timeZoneName")?.value || null
    );
  } catch {
    return null;
  }
}

// A timestamp split for the two-line "Last updated" cell: "2:37 AM" over
// "07/31". Rendered in the viewer's own timezone — unlike the appointment
// columns, this answers "how fresh is this?", which is a question about the
// clock on the wall in front of you, not the one at the delivery.
function timeStamp(iso) {
  if (!iso) return null;
  const d = new Date(String(iso).replace(" ", "T"));
  if (!Number.isFinite(d.getTime())) return null;
  return {
    // Zone named on the time line. Every other time in this table is in the
    // DESTINATION's zone, so an unlabelled local time here is a trap — these
    // two columns are the only ones on the viewer's own clock.
    time: `${d.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    })} ${localZone()}`,
    date: d.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit" }),
  };
}

// The viewer's own timezone abbreviation, e.g. "CDT". Computed once per render
// pass rather than per cell.
let _zoneCache = null;
function localZone() {
  if (_zoneCache) return _zoneCache;
  try {
    _zoneCache =
      new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value || "";
  } catch {
    _zoneCache = "";
  }
  return _zoneCache;
}

// Split an ETA into clock time and date, in the DESTINATION's timezone.
// "5:06 AM CDT" over "Jul 31" — the zone stays on the time line because a bare
// "5:06 AM" is exactly the ambiguity that makes a dispatcher second-guess.
function etaParts(iso, timeZone) {
  if (!iso) return null;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  const tz = timeZone || undefined;
  try {
    return {
      time: new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true, timeZoneName: "short",
      }).format(d),
      date: new Intl.DateTimeFormat("en-US", {
        timeZone: tz, month: "short", day: "numeric",
      }).format(d),
    };
  } catch {
    return null;
  }
}

/**
 * When this row is next due, and how often it is being checked.
 *
 * The cadence is not stored anywhere — the scheduler picks an interval from the
 * row's slack (deadline minus projected ETA) and writes only the resulting
 * timestamp. But the gap between the last check and the next one IS that
 * interval, so it can be recovered here without shipping the tier down.
 *
 * That gap is the answer to "why has this row not updated recently?": a load
 * with six hours of buffer is deliberately on a three-hour cadence, and its ETA
 * being an hour stale is the system working, not failing.
 */
function nextCheckInfo(row) {
  if (!row.next_check_at) return null;
  const next = new Date(row.next_check_at);
  if (!Number.isFinite(next.getTime())) return null;

  const when =
    next <= new Date()
      ? "due now"
      : `${next.toLocaleTimeString("en-US", {
          hour: "numeric",
          minute: "2-digit",
        })} ${localZone()}`;

  let every = "";
  if (row.updated_at) {
    const gapMin = (next - new Date(String(row.updated_at).replace(" ", "T"))) / 60000;
    if (gapMin > 0) {
      // Switch to hours at 60, not 90 — the 1-hour tier read as "every 60m".
      every =
        gapMin >= 59
          ? `every ${Math.round(gapMin / 60)}h`
          : `every ${Math.max(1, Math.round(gapMin))}m`;
    }
  }
  return {
    when,
    every,
    title:
      `Next check ${next.toLocaleString()}` +
      (every ? ` — ${every}, chosen from how much slack this load has.` : ""),
  };
}

function StatusBadge({ row }) {
  const map = {
    on_time: ["ontime", "On time"],
    late: ["late", "Late"],
    arrived: ["arrived", "Arrived"],
    unpaid: ["unpaid", "Needs credit"],
    error: ["error", "Couldn't track"],
    unknown: ["unknown", "—"],
  };
  const [cls, label] = map[row.status] || map.unknown;

  // Prefer the raw instant so time and date can be split onto their own lines;
  // fall back to the server's pre-formatted string for rows checked before
  // eta_iso was carried to the client.
  const parts = etaParts(row.eta_iso, row.dest_tz);
  const isError = row.status === "error";

  return (
    <span
      className={`badge ${cls}`}
      title={[row.status_note, row.truck_at].filter(Boolean).join(" — ")}
    >
      <span className="dot" />
      <span className="badge-text">
        <span className="badge-label">{label}</span>
        {isError ? (
          row.status_note ? <span className="eta-note">{row.status_note}</span> : null
        ) : parts ? (
          <>
            <span className="eta-note">ETA {parts.time}</span>
            <span className="eta-note">{parts.date}</span>
          </>
        ) : row.eta_display ? (
          <span className="eta-note">ETA {row.eta_display}</span>
        ) : null}
      </span>
    </span>
  );
}

// One checkbox in the "Email alerts" column.
//
// The hint has to reach touch users too, and a plain `title` never fires on a
// phone. So the checkbox and its word are separate controls: tapping the box
// toggles, tapping the word reveals the hint. Wrapping both in one <label>
// would have made the word toggle the box, leaving no way to just read it.
function MailToggle({ label, hint, checked, onChange }) {
  const id = useId();
  const [showTip, setShowTip] = useState(false);
  return (
    <div className="mail-toggle">
      <input
        id={id}
        type="checkbox"
        aria-label={hint}
        checked={!!checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <button
        type="button"
        className="mail-toggle-word"
        title={hint}
        aria-expanded={showTip}
        onClick={() => setShowTip((s) => !s)}
        onBlur={() => setShowTip(false)}
      >
        {label}
      </button>
      {showTip ? <span className="mail-tip">{hint}</span> : null}
    </div>
  );
}

export default function Page() {
  const [rows, setRows] = useState(() => Array.from({ length: MIN_ROWS }, (_, i) => blankRow(i)));
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Positions the server currently has rows for. The on-screen table is not a
  // reliable record of this: it shrinks as it empties, so it can forget rows
  // that still exist in the database.
  const serverPositions = useRef(new Set());

  // Declared before refresh() so every row-building call site can be given the
  // account's cap. An admin can lower it per profile; MAX_ROWS is the default.
  const maxRows = profile?.max_rows ?? MAX_ROWS;

  // `full` rebuilds the table from the server (initial load, and after a save,
  // where the server's copy IS the truth). The polling path never does this —
  // see applyServerFields.
  async function refresh({ full = false } = {}) {
    const r = await fetch("/api/loads").then((x) => x.json());
    if (r.loads) {
      serverPositions.current = new Set(r.loads.map((l) => l.position));
      setRows((prev) => (full ? mergeRows(r.loads, maxRows) : applyServerFields(prev, r.loads)));
    }
    if (r.profile) setProfile(r.profile);
    if (r.error) setMessage("Couldn't load data: " + r.error);
  }

  // A row that has been SAVED and has everything it needs but no result yet is
  // still being worked on by the background checker.
  //
  // The `r.id` test is essential: without it a row became "checking" the moment
  // the truck # and date were typed, which showed the working spinner before
  // anything had been submitted and put the whole table on a 12-second poll
  // while the user was still typing into it. Nothing contacts a provider until
  // Save & Check writes the row and the worker picks it up.
  const checking = useMemo(
    () => rows.some((r) => r.id && r.source && r.deadline && r.status === "unknown"),
    [rows]
  );

  useEffect(() => {
    (async () => {
      try {
        await refresh({ full: true });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    // The server re-checks on its own schedule, so the table only needs to pick
    // up what the worker has written. Poll faster while something is pending so
    // the first result appears promptly.
    const t = setInterval(refresh, checking ? 12000 : 60000);
    return () => clearInterval(t);
  }, [checking]);

  const filled = useMemo(() => rows.filter((r) => !rowEmpty(r)).length, [rows]);
  const overCap = filled > maxRows;

  // The first blank row is where the next load goes, so it gets a highlight the
  // other blanks don't. Everything below it is just runway.
  const firstEmpty = useMemo(() => rows.findIndex((r) => rowEmpty(r)), [rows]);

  // ---- Save & Check throttle -------------------------------------------
  //
  // Every saved row is queued for an immediate check, so repeated saves are
  // what turn one table into dozens of provider calls. The button locks for
  // COOLDOWN_MIN_MS and then stays locked until the first results land.
  //
  // COOLDOWN_MAX_MS is the release valve: `checking` clears when the worker
  // writes a result, but if the cron is wedged it would never clear, and a
  // permanently dead button is a worse failure than an extra API call. After
  // three minutes the user gets control back regardless.
  const COOLDOWN_MIN_MS = 30000;
  const COOLDOWN_MAX_MS = 180000;
  const [lockedAt, setLockedAt] = useState(0);
  const [tick, setTick] = useState(0);

  const sinceSave = lockedAt ? tick - lockedAt : Infinity;
  const locked =
    lockedAt > 0 &&
    (sinceSave < COOLDOWN_MIN_MS || (checking && sinceSave < COOLDOWN_MAX_MS));
  const cooldownLeft = locked ? Math.ceil((COOLDOWN_MIN_MS - sinceSave) / 1000) : 0;

  useEffect(() => {
    if (!lockedAt) return;
    setTick(Date.now());
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [lockedAt]);

  useEffect(() => {
    // Drop the timer once the lock expires so the page isn't ticking forever.
    if (lockedAt && !locked) setLockedAt(0);
  }, [locked, lockedAt]);

  function update(i, field, value) {
    setRows((prev) => {
      const next = prev.slice();
      const row = { ...next[i], [field]: value };
      // The alert time mirrors the appointment until it's edited directly,
      // after which it stays pinned so an appointment change can't silently
      // move the thing the alerts actually fire on.
      if (field === "appt_at" && !row.alert_unlinked) row.deadline = value;
      if (field === "deadline") row.alert_unlinked = true;
      next[i] = row;
      return withSpare(next, maxRows);
    });
  }

  function relink(i) {
    setRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], alert_unlinked: false, deadline: next[i].appt_at };
      return next;
    });
  }

  function clearRow(i) {
    setRows((prev) => {
      const next = prev.slice();
      next[i] = blankRow(next[i].position);
      return withSpare(next, maxRows);
    });
    setMessage("Row cleared — it leaves the database on the next save.");
  }

  async function clearAll() {
    if (!window.confirm("Clear ALL rows? This cannot be undone.")) return;
    setSaving(true);
    try {
      const res = await fetch("/api/loads", { method: "DELETE" }).then((r) => r.json());
      if (res.error) return setMessage("Clear failed: " + res.error);
      serverPositions.current = new Set();
      setRows(Array.from({ length: MIN_ROWS }, (_, i) => blankRow(i)));
      setMessage("All loads cleared.");
    } finally {
      setSaving(false);
    }
  }

  function handleDestPaste(i, e) {
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    const parsed = parseLoads(text);
    if (!parsed.length) return;
    e.preventDefault();
    let assumed = 0;
    setRows((prev) => {
      const next = prev.slice();
      let pi = 0;
      const fill = (idx, p) => {
        next[idx] = {
          ...next[idx],
          name: p.notes || "",
          kind: p.kind,
          appt_at: p.deadline || "",
          deadline: p.deadline || "",
          alert_unlinked: false,
          destination: p.destination || "",
        };
        if (p.timeAssumed) assumed++;
      };
      fill(i, parsed[pi++]);
      let j = i + 1;
      while (pi < parsed.length) {
        while (j < next.length && !rowEmpty(next[j])) j++;
        if (j >= next.length) next.push(blankRow(next.length));
        fill(j, parsed[pi++]);
        j++;
      }
      return withSpare(next, maxRows);
    });
    let msg = `Added ${parsed.length} stop${parsed.length === 1 ? "" : "s"}. Add the truck # or Live Share link, then Save.`;
    if (assumed) msg += ` ${assumed} had no time — set to 23:59; adjust if needed.`;
    setMessage(msg);
  }

  async function save() {
    setSaving(true);
    setMessage("Saving…");
    try {
      const payload = rows.map((r) => ({
        position: r.position,
        name: r.name,
        kind: r.kind,
        appt_at: r.appt_at,
        deadline: r.deadline || r.appt_at,
        alert_unlinked: r.alert_unlinked,
        source: r.source,
        destination: r.destination,
        notes: r.notes,
        alert_enabled: r.alert_enabled,
        checkin_enabled: r.checkin_enabled,
      }));

      // Deletions are expressed as "this position is now empty", so a position
      // the server holds MUST appear in the payload to be removed.
      //
      // The table shrinks when it empties out — withSpare keeps only MIN_ROWS
      // plus a few spares — so clearing the last rows dropped them from the
      // array before this ran. They vanished from the screen, were never sent,
      // and came straight back on the next refresh. That is why the bottom
      // rows would not delete no matter how many times you tried.
      //
      // Anything the server knows about and the screen no longer shows is
      // therefore added back as an explicit blank.
      const sent = new Set(payload.map((p) => p.position));
      for (const pos of serverPositions.current) {
        if (sent.has(pos)) continue;
        payload.push({
          position: pos,
          name: "",
          kind: "delivery",
          appt_at: "",
          deadline: "",
          alert_unlinked: false,
          source: "",
          destination: "",
          notes: "",
          alert_enabled: true,
          checkin_enabled: false,
        });
      }
      const res = await fetch("/api/loads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      }).then((r) => r.json());
      if (res.error) return setMessage("Save failed: " + res.error);
      // The PUT response IS the server's post-save truth, so a full rebuild is
      // correct here (unlike the poll).
      if (res.loads) {
        serverPositions.current = new Set(res.loads.map((l) => l.position));
        setRows(mergeRows(res.loads, maxRows));
      }
      if (res.profile) setProfile(res.profile);
      setLockedAt(Date.now());
      // A bad link is not a failed save — the rest of the table is fine — but
      // it must not be reported as an unqualified success either, or the user
      // walks away believing a load is being watched when it isn't.
      const bad = res.linkErrors || [];
      if (bad.length) {
        setMessage(
          `Saved, but ${bad.length === 1 ? "row" : "rows"} ${bad
            .map((e) => e.row)
            .join(", ")} ${bad.length === 1 ? "isn't" : "aren't"} being tracked — ` +
            bad[0].message
        );
      } else {
        setMessage(
          "Saved — checking now. ETAs appear on their own; you don't need to press anything again."
        );
      }
      // Nudge the first refresh so a result can appear without waiting a full
      // polling interval.
      setTimeout(refresh, 4000);
    } catch (e) {
      setMessage("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function checkin(row, state) {
    await fetch("/api/loads/checkin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ loadId: row.id, state }),
    });
    refresh();
  }

  async function signOut() {
    await getBrowserSupabase().auth.signOut();
    window.location.href = "/login";
  }

  const busy = saving || loading;
  const saveBlocked = busy || locked;
  const lowBalance = profile && profile.balance_cents < 200;

  const saveLabel = saving
    ? "Saving…"
    : cooldownLeft > 0
    ? `Checking… ${cooldownLeft}s`
    : locked
    ? "Checking…"
    : "Save & Check";
  const saveTitle = locked
    ? "Checking the rows you just saved. The button unlocks when the first ETAs come back."
    : "Save the table and start checking ETAs";

  // The table is wider than the viewport and the useful columns now sit at both
  // ends, so a bottom-only scrollbar means scrolling to the bottom of a 20-row
  // table just to pan sideways. Mirror it above the header and keep the two in
  // step. The guard flag stops each one's programmatic scroll from echoing back.
  const topBarRef = useRef(null);
  const bodyRef = useRef(null);
  const tableRef = useRef(null);
  const syncing = useRef(false);
  const [tableWidth, setTableWidth] = useState(0);

  useEffect(() => {
    const el = tableRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setTableWidth(el.scrollWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length]);

  function syncScroll(from) {
    if (syncing.current) return;
    const src = from === "top" ? topBarRef.current : bodyRef.current;
    const dst = from === "top" ? bodyRef.current : topBarRef.current;
    if (!src || !dst) return;
    syncing.current = true;
    dst.scrollLeft = src.scrollLeft;
    requestAnimationFrame(() => {
      syncing.current = false;
    });
  }

  return (
    <div className="wrap">
      <div className="header">
        <div className="brand">
          {/* Plain <img> rather than next/image: this is a fixed-size static
              asset, so the optimiser buys nothing, and explicit width/height
              means the header never reflows once the logo decodes. */}
          <img
            src="/logo.png"
            alt=""
            width={1200}
            height={397}
            className="brand-mark"
          />
          <div>
            <h1 className="title">TruckOn.site</h1>
            <p className="subtitle">
              Let us monitor your loads and alert you as soon as ETA is delayed.
            </p>
          </div>
        </div>
        <div className="header-right">
          <ThemeToggle />
          {profile ? <Balance balanceCents={profile.balance_cents || 0} /> : null}
          <button className="btn secondary" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          {/* The balance chip also links here, but a chip showing a dollar
              amount doesn't announce that past loads live behind it. A labelled
              button does. */}
          <Link className="btn secondary" href="/history">
            History &amp; billing
          </Link>
          <button className="btn secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      {showSettings ? (
        <Settings profile={profile} onClose={() => setShowSettings(false)} onSaved={refresh} />
      ) : null}

      <div className="card">
        <div className="toolbar">
          {/* The running row count lived here and was noise — the table itself
              shows how full it is, and the "…" row below it carries the limit.
              Only the over-cap warning survives, because that one is actionable:
              rows past the cap are silently dropped on save. */}
          <span className="status-line">
            {overCap ? `Over the ${maxRows}-row limit — extra rows won't save` : ""}
          </span>
          <div className="toolbar-actions">
            <button className="btn ghost pale" onClick={() => setShowHelp((v) => !v)}>
              {showHelp ? "Instructions ▲" : "Instructions ▼"}
            </button>
            <button className="btn secondary" onClick={clearAll} disabled={busy}>
              Clear all
            </button>
            <button className="btn" onClick={save} disabled={saveBlocked} title={saveTitle}>
              {saveLabel}
            </button>
          </div>
        </div>

        {showHelp ? <Instructions /> : null}

        {/* Checking can take a minute or two. Without a visible working state
            users assume the save failed and hammer the button. Only shown for
            rows that have actually been saved — see `checking`. */}
        {checking ? (
          <p className="paste-result working">
            <span className="spinner" />
            Working on it — finding your trucks and calculating ETAs. This can take
            a minute or two, and updates appear on their own. Keep filling in rows
            if you like; nothing you type will be lost.
          </p>
        ) : null}

        {/* A low balance no longer stops anything — rows keep tracking and the
            balance is allowed to go negative — so this is a reminder, not a
            warning, and it must not read like tracking is about to stop. */}
        {lowBalance ? (
          <p className="paste-result">
            Your balance is {profile.balance_cents < 0 ? "negative" : "low"}. Tracking
            keeps running; ask your administrator to top up when convenient.
          </p>
        ) : null}
        {/* "isn't/aren't being tracked" is the link-rejection message, which is
            a warning rather than a failure — but it must not render green, or it
            reads as everything being fine. */}
        {message && !checking ? (
          <p
            className={
              "paste-result" +
              (/fail|error|couldn|isn't being tracked|aren't being tracked/i.test(message)
                ? " err"
                : "")
            }
          >
            {message}
          </p>
        ) : null}

        <div
          className="table-scroll-top"
          ref={topBarRef}
          onScroll={() => syncScroll("top")}
          aria-hidden="true"
        >
          <div className="table-scroll-ghost" style={{ width: tableWidth || "100%" }} />
        </div>

        <div className="table-scroll" ref={bodyRef} onScroll={() => syncScroll("body")}>
          <table ref={tableRef}>
            <thead>
              <tr>
                <th className="col-clear" />
                <th className="col-idx">#</th>
                <th className="col-loc">Last location</th>
                <th className="col-updated">Last updated</th>
                <th className="col-next">Next check</th>
                <th className="col-miles">
                  Miles
                  <br />
                  left
                </th>
                <th className="col-status">Status</th>
                <th className="col-checkin">Check-in</th>
                <th>Truck # or link</th>
                <th className="col-stop">PASTE HERE 🔽</th>
                <th className="col-half">ALERT IF LATER THAN…</th>
                <th className="col-mail">Email alerts</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const needsCheckin = r.checkin_state === "due" || r.checkin_state === "missed";
                const stamp = timeStamp(r.updated_at);
                const nextCheck = nextCheckInfo(r);
                const badLink = shareLinkProblem(r.source);
                // A check is outstanding when the worker owes this row an
                // answer: either it has never produced one, or its scheduled
                // time has come round and the cron hasn't swept it yet.
                const pending =
                  !!r.id &&
                  !!r.source &&
                  !!r.deadline &&
                  (r.status === "unknown" ||
                    (!!r.next_check_at && new Date(r.next_check_at) <= new Date()));
                const zone = tzAbbr(r.dest_tz, r.appt_at || r.deadline);
                const zoneHint = zone
                  ? `Times are local to the delivery (${r.dest_tz}), not your own clock.`
                  : "";
                return (
                  <tr
                    key={i}
                    className={
                      (r.checkin_state === "missed" ? "row-missed " : "") +
                      (r.checkin_state === "due" ? "row-checkin " : "") +
                      // Blank rows fade back so the loads you are actually
                      // tracking are what the eye lands on; the first blank one
                      // stays lit because that is where the next load goes.
                      (rowEmpty(r) ? (i === firstEmpty ? "row-next " : "row-blank ") : "")
                    }
                  >
                    <td className="col-clear">
                      {!rowEmpty(r) ? (
                        <button className="clear-btn" title="Clear this row" onClick={() => clearRow(i)}>
                          ×
                        </button>
                      ) : null}
                    </td>
                    <td className="col-idx">{i + 1}</td>
                    <td className="col-loc">
                      <span className="muted">{r.last_place || "—"}</span>
                    </td>
                    <td className="col-updated">
                      {pending ? (
                        <span className="checking-cell" title="Checking location and ETA…">
                          <span className="spinner tiny" />
                          <span className="checking-word">checking</span>
                        </span>
                      ) : stamp ? (
                        <span title={`Last checked ${new Date(r.updated_at).toLocaleString()}`}>
                          <span className="stamp-time">{stamp.time}</span>
                          <span className="stamp-date">{stamp.date}</span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="col-next">
                      {nextCheck ? (
                        <span title={nextCheck.title}>
                          <span className="stamp-time">{nextCheck.when}</span>
                          <span className="stamp-date">{nextCheck.every}</span>
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="col-miles">
                      {typeof r.miles_left === "number" ? (
                        <span title={r.position_precision === "city" ? "Approximate — city-level position" : ""}>
                          {Math.round(r.miles_left)}
                          {r.position_precision === "city" ? "≈" : ""}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    {/* Status always shows the ETA. The check-in prompt used to
                        replace it, which meant that the moment a driver needed
                        chasing you lost sight of whether the load was late —
                        exactly when you most want both facts at once. */}
                    <td className="col-status">
                      <StatusBadge row={r} />
                    </td>
                    <td className="col-checkin">
                      {needsCheckin ? (
                        <div className="checkin-box">
                          <span className="checkin-label">
                            {r.checkin_state === "missed" ? "Not checked in!" : "Check in?"}
                          </span>
                          <div className="checkin-actions">
                            <button className="chip ok" onClick={() => checkin(r, "checked_in")}>
                              ✓ IN
                            </button>
                            <button className="chip no" onClick={() => checkin(r, "missed")}>
                              ✗ Didn&rsquo;t
                            </button>
                          </div>
                        </div>
                      ) : r.checkin_state === "checked_in" ? (
                        <span className="checkin-done" title="Driver confirmed checked in">
                          ✓ Checked in
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>
                      <input
                        className={"source-input" + (badLink ? " invalid" : "")}
                        placeholder="3040 or Samsara link"
                        value={r.source}
                        onChange={(e) => update(i, "source", e.target.value)}
                        aria-invalid={badLink ? "true" : undefined}
                        title={badLink || undefined}
                      />
                      {/* Shown as they type, not after saving. A link that
                          can't be read is almost always a truncated copy, and
                          the moment to say so is while the clipboard is still
                          in reach. */}
                      {badLink ? <span className="field-error">{badLink}</span> : null}
                    </td>
                    {/* One stop = one cell: what kind, when, which facility and
                        where. These were three columns that were always read
                        together, and splitting them meant scrolling sideways to
                        answer a single question. The order matches a pasted
                        load block — date/time, facility, address — so the cell
                        reads the way the source document does. The address is a
                        textarea, not an input, so a two-line address stays
                        readable instead of being clipped to one line. */}
                    <td className="col-stop">
                      <div className="stop-cell">
                        <div className="stop-when">
                          <select
                            className="kind-select"
                            value={r.kind}
                            onChange={(e) => update(i, "kind", e.target.value)}
                          >
                            <option value="delivery">DEL</option>
                            <option value="pickup">PU</option>
                          </select>
                          <input
                            className="small"
                            type="datetime-local"
                            value={r.appt_at}
                            onChange={(e) => update(i, "appt_at", e.target.value)}
                          />
                          {zone ? (
                            <span className="tz-tag" title={zoneHint}>
                              {zone}
                            </span>
                          ) : null}
                        </div>
                        <input
                          className="facility-input"
                          placeholder="Facility name (from paste)"
                          value={r.name}
                          onChange={(e) => update(i, "name", e.target.value)}
                        />
                        <textarea
                          className="dest-input"
                          rows={2}
                          placeholder="Paste the whole load block here"
                          value={r.destination}
                          // The address wraps visually; it must not contain
                          // literal newlines. An <input> stripped them for
                          // free, a <textarea> does not — and a newline inside
                          // the string reaches the geocoder verbatim.
                          onChange={(e) =>
                            update(i, "destination", e.target.value.replace(/\s*\n\s*/g, " "))
                          }
                          // Enter would insert a newline that the handler above
                          // then strips, which looks like the key doing nothing.
                          // Blocking it is the honest version of the same result.
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.preventDefault();
                          }}
                          onPaste={(e) => handleDestPaste(i, e)}
                        />
                      </div>
                    </td>
                    <td className="col-half">
                      <div className="alert-cell">
                        <input
                          className="small"
                          type="datetime-local"
                          value={r.deadline}
                          onChange={(e) => update(i, "deadline", e.target.value)}
                        />
                        {zone ? (
                          <span className="tz-tag" title={zoneHint}>
                            {zone}
                          </span>
                        ) : null}
                        {r.alert_unlinked ? (
                          <button
                            className="link-btn"
                            title="Pinned — click to follow DATE & TIME again"
                            onClick={() => relink(i)}
                          >
                            🔗
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="col-mail">
                      <MailToggle
                        label="alert"
                        hint="alert me if ETA is late"
                        checked={r.alert_enabled}
                        onChange={(v) => update(i, "alert_enabled", v)}
                      />
                      <MailToggle
                        label="remind"
                        hint="remind me 5 min before del appt"
                        checked={r.checkin_enabled}
                        onChange={(v) => update(i, "checkin_enabled", v)}
                      />
                    </td>
                    <td>
                      <input
                        className="notes-input"
                        placeholder="Notes"
                        value={r.notes}
                        onChange={(e) => update(i, "notes", e.target.value)}
                      />
                    </td>
                  </tr>
                );
              })}
              {/* Tells the user the table isn't finished at the last blank row.
                  Hidden at the cap, because at that point there genuinely are
                  no more rows coming and an ellipsis would be a lie. */}
              {rows.length < maxRows ? (
                <tr className="more-row">
                  <td colSpan={13} title={`More rows appear as you fill these in — up to ${maxRows}.`}>
                    <span className="more-dots">…</span>
                    <span className="more-text">
                      {maxRows - rows.length} more row
                      {maxRows - rows.length === 1 ? "" : "s"} available
                    </span>
                  </td>
                </tr>
              ) : (
                <tr className="more-row">
                  <td colSpan={13}>
                    <span className="more-text">
                      Row limit reached — {maxRows} of {maxRows}.
                    </span>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="savebar">
          <span className="save-note">{message}</span>
          <button className="btn secondary" onClick={clearAll} disabled={busy}>
            Clear all
          </button>
          <button className="btn" onClick={save} disabled={saveBlocked} title={saveTitle}>
            {saveLabel}
          </button>
        </div>
      </div>

      <p className="footer">
        Each tracked stop costs $2, charged once the truck arrives or the driver
        is marked checked in. Loads that never complete are never charged.
      </p>
    </div>
  );
}

