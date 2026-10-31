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
  applySavedRows,
} from "../lib/rows";
import { parseMotiveUrl, shareLinkProblem } from "../lib/shareLink";
import { appointmentHasPassed } from "../lib/dispatchTime";

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
function MailToggle({ label, hint, checked, onChange, disabled = false }) {
  const id = useId();
  const [showTip, setShowTip] = useState(false);
  return (
    <div className="mail-toggle">
      <label className="switch-control" htmlFor={id}>
        <input
          id={id}
          type="checkbox"
          aria-label={hint}
          checked={!!checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch-slider" aria-hidden="true" />
      </label>
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

function motionStale(at) {
  const timestamp = Date.parse(at || "");
  return !Number.isFinite(timestamp) || Date.now() - timestamp > 30 * 60 * 1000;
}

export default function Page() {
  const [rows, setRows] = useState(() => Array.from({ length: MIN_ROWS }, (_, i) => blankRow(i)));
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [message, setMessage] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAiImport, setShowAiImport] = useState(false);
  const [aiText, setAiText] = useState("");
  const [aiParsing, setAiParsing] = useState(false);
  const latestRows = useRef(rows);
  latestRows.current = rows;
  const editVersionRef = useRef(0);
  const saveInFlight = useRef(false);
  const saveAgain = useRef(false);
  const saveTimer = useRef(null);
  const suppressAutosave = useRef(false);
  const motiveChecksInFlight = useRef(false);
  const motiveChecksStarted = useRef(new Set());
  const motiveCheckQueue = useRef(new Map());
  const [editVersion, setEditVersion] = useState(0);

  // Declared before refresh() so every row-building call site can be given the
  // account's cap. An admin can lower it per profile; MAX_ROWS is the default.
  const maxRows = profile?.max_rows ?? MAX_ROWS;

  // `full` rebuilds the table from the server (initial load, and after a save,
  // where the server's copy IS the truth). The polling path never does this —
  // see applyServerFields.
  async function refresh({ full = false } = {}) {
    const r = await fetch("/api/loads").then((x) => x.json());
    if (r.loads) {
      setRows((prev) => (full ? mergeRows(r.loads, maxRows) : applyServerFields(prev, r.loads)));
    }
    if (r.profile) setProfile(r.profile);
    if (r.error) setMessage("Couldn't load data: " + r.error);
  }

  const checking = useMemo(
    () =>
      updating ||
      rows.some(
        (r) =>
          r.tracking_enabled &&
          r.id &&
          r.source &&
          r.deadline &&
          (r.status === "unknown" ||
            (!!r.next_check_at && new Date(r.next_check_at) <= new Date()))
      ),
    [rows, updating]
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

  function markDirty() {
    editVersionRef.current += 1;
    setEditVersion(editVersionRef.current);
  }

  function update(i, field, value) {
    markDirty();
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
    markDirty();
    setRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], alert_unlinked: false, deadline: next[i].appt_at };
      return next;
    });
  }

  async function checkNewMotiveLinks(savedLoads) {
    for (const load of savedLoads || []) {
      if (!parseMotiveUrl(load.samsara_url) || !load.id || !load.deadline) continue;
      const key = `${load.id}:${load.samsara_url}`;
      if (motiveChecksStarted.current.has(key)) continue;
      motiveChecksStarted.current.add(key);
      motiveCheckQueue.current.set(key, load);
    }
    if (motiveChecksInFlight.current || !motiveCheckQueue.current.size) return;

    motiveChecksInFlight.current = true;
    setUpdating(true);
    try {
      while (motiveCheckQueue.current.size) {
        const batch = [...motiveCheckQueue.current.values()];
        motiveCheckQueue.current.clear();
        setMessage(`Checking ${batch.length} Motive link${batch.length === 1 ? "" : "s"} now…`);
        const response = await fetch("/api/loads/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ load_ids: batch.map((load) => load.id) }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Motive check could not run.");
        await refresh();
        const errors = (result.results || []).filter((item) => item.status === "error");
        if (errors.length) {
          const detail = errors.map((item) => item.error).filter(Boolean).join("; ");
          setMessage(`Motive check failed${detail ? `: ${detail}` : ". Check the row status for details."}`);
        } else if (result.checked) {
          setMessage(
            `Motive link${batch.length === 1 ? "" : "s"} checked. ` +
              (batch.some((load) => load.tracking_enabled)
                ? "Scheduled Track is on."
                : "Turn on Track to keep checking automatically.")
          );
        } else {
          setMessage("Motive check did not run. Use Update all now and check the row status.");
        }
      }
    } catch (error) {
      setMessage(`Motive check failed: ${error.message}`);
    } finally {
      motiveChecksInFlight.current = false;
      setUpdating(false);
      if (motiveCheckQueue.current.size) void checkNewMotiveLinks([]);
    }
  }

  function setTracking(i, enabled) {
    const row = latestRows.current[i];
    if (enabled && (!row?.appt_at || !row?.deadline)) {
      setMessage("Enter the appointment date and time in Stop info before turning on Track.");
      return;
    }
    markDirty();
    setRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], tracking_enabled: enabled, alert_enabled: enabled };
      return next;
    });
  }

  function clearRow(i) {
    markDirty();
    setRows((prev) => {
      return withSpare(
        prev.filter((_, index) => index !== i).map((row, position) => ({ ...row, position })),
        maxRows
      );
    });
    setMessage("Row removed — saving changes…");
  }

  async function clearAll() {
    if (!window.confirm("Clear ALL rows? They will be removed from the board and kept in History for 7 days.")) return;
    clearTimeout(saveTimer.current);
    saveAgain.current = false;
    suppressAutosave.current = true;
    editVersionRef.current += 1;
    setEditVersion(editVersionRef.current);
    setSaving(true);
    try {
      const res = await fetch("/api/loads", { method: "DELETE" }).then((r) => r.json());
      if (res.error) return setMessage("Clear failed: " + res.error);
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
    const missingTime = parsed.filter((stop) => !stop.deadline);
    if (missingTime.length) {
      setMessage(
        `Appointment time missing for ${missingTime.length} stop${missingTime.length === 1 ? "" : "s"}. Enter a date and time in the dispatch text, then paste again.`
      );
      return;
    }
    const futureStops = parsed.filter(
      (stop) => !appointmentHasPassed({ appointmentAt: stop.deadline, destination: stop.destination })
    );
    const skippedPast = parsed.length - futureStops.length;
    if (!futureStops.length) {
      setMessage("All pickup/delivery appointment times in that dispatch have already passed, so no stops were added.");
      return;
    }
    markDirty();
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
      };
      fill(i, futureStops[pi++]);
      let j = i + 1;
      while (pi < futureStops.length) {
        while (j < next.length && !rowEmpty(next[j])) j++;
        if (j >= next.length) next.push(blankRow(next.length));
        fill(j, futureStops[pi++]);
        j++;
      }
      return withSpare(next, maxRows);
    });
    let msg = `Added ${futureStops.length} stop${futureStops.length === 1 ? "" : "s"}. Add the truck # or a Samsara/Motive share link.`;
    if (skippedPast) msg += ` Skipped ${skippedPast} stop${skippedPast === 1 ? "" : "s"} with appointment times that had passed.`;
    setMessage(msg);
  }

  async function save() {
    if (saveInFlight.current) {
      saveAgain.current = true;
      return;
    }
    saveInFlight.current = true;
    setSaving(true);
    try {
      let more = true;
      while (more) {
        saveAgain.current = false;
        const version = editVersionRef.current;
        const payload = latestRows.current.map((r) => ({
          client_key: r.client_key,
          id: r.id,
          position: r.position,
          load_number: r.load_number,
          name: r.name,
          kind: r.kind,
          appt_at: r.appt_at,
          deadline: r.deadline || r.appt_at,
          alert_unlinked: r.alert_unlinked,
          source: r.source,
          destination: r.destination,
          notes: r.notes,
          tracking_enabled: r.tracking_enabled,
          alert_enabled: r.tracking_enabled,
          telegram_enabled: false,
          telegram_interval_minutes: 0,
          checkin_enabled: r.checkin_enabled,
        }));
        const response = await fetch("/api/loads", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: payload }),
        });
        const res = await response.json();
        if (!response.ok || res.error) throw new Error(res.error || "Could not save changes.");

        if (res.loads) {
          setRows((current) => applySavedRows(current, res.loads, payload));
          void checkNewMotiveLinks(res.loads);
        }
        if (res.profile) setProfile(res.profile);
        const changedDuringSave = version !== editVersionRef.current || saveAgain.current;
        const bad = res.linkErrors || [];
        if (bad.length) {
          setMessage(
            `Saved, but ${bad.length === 1 ? "row" : "rows"} ${bad
              .map((e) => e.row)
              .join(", ")} ${bad.length === 1 ? "has" : "have"} an invalid tracking link: ${bad[0].message}`
          );
        } else if (!changedDuringSave) {
          setMessage("All changes saved.");
        }
        more = changedDuringSave;
      }
    } catch (e) {
      setMessage("Save failed: " + e.message);
    } finally {
      setSaving(false);
      saveInFlight.current = false;
      if (saveAgain.current) {
        saveAgain.current = false;
        saveTimer.current = setTimeout(save, 400);
      }
    }
  }

  useEffect(() => {
    if (editVersion === 0) return;
    if (suppressAutosave.current) {
      suppressAutosave.current = false;
      return;
    }
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(save, 600);
    return () => clearTimeout(saveTimer.current);
  }, [editVersion]);

  async function importWithAi() {
    if (!aiText.trim()) return setMessage("Paste the load information first.");
    setAiParsing(true);
    setMessage("Reading load details with AI…");
    try {
      const response = await fetch("/api/loads/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: aiText }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Could not read the load information.");

      const missingTime = (result.stops || []).filter(
        (stop) => !stop.appointmentAt && !stop.deadline
      );
      if (missingTime.length) {
        throw new Error(
          `Appointment date and time are missing for ${missingTime.length} stop${missingTime.length === 1 ? "" : "s"}. Add a time to each pickup and delivery, then try again.`
        );
      }
      const futureStops = (result.stops || []).filter(
        (stop) => !appointmentHasPassed(stop)
      );
      const skippedPast = (result.stops || []).length - futureStops.length;
      if (!futureStops.length) {
        throw new Error("All pickup/delivery appointment times in that dispatch have already passed, so no stops were added.");
      }
      const available = Math.max(0, maxRows - rows.filter((row) => !rowEmpty(row)).length);
      const stops = futureStops.slice(0, available);
      if (!stops.length) {
        throw new Error(result.stops?.length ? "Your board has reached its row limit." : "No usable pickup or delivery stops were found.");
      }

      setRows((current) => {
        const next = current.slice();
        for (const stop of stops) {
          let index = next.findIndex(rowEmpty);
          if (index < 0) {
            index = next.length;
            next.push(blankRow(index));
          }
          const source = stop.motiveUrl || stop.samsaraUrl || stop.truckNumber || "";
          next[index] = {
            ...next[index],
            name: stop.facility || (stop.kind === "pickup" ? "Pickup" : "Delivery"),
            load_number: stop.loadNumber || "",
            kind: stop.kind,
            appt_at: stop.appointmentAt || stop.deadline || "",
            deadline: stop.deadline || stop.appointmentAt || "",
            alert_unlinked: false,
            source,
            destination: stop.destination || "",
            notes: stop.notes || "",
          };
        }
        return withSpare(next, maxRows);
      });
      markDirty();
      let importMessage = `Added ${stops.length} stop${stops.length === 1 ? "" : "s"} to the board. Add a truck number or a Samsara/Motive share link if missing, then turn on Track when ready.`;
      if (skippedPast) importMessage += ` Skipped ${skippedPast} stop${skippedPast === 1 ? "" : "s"} with appointment times that had passed.`;
      setMessage(importMessage);
      setAiText("");
      setShowAiImport(false);
    } catch (e) {
      setMessage(`AI import failed: ${e.message}`);
    } finally {
      setAiParsing(false);
    }
  }

  async function updateAllNow() {
    setUpdating(true);
    setMessage("Updating active loads now…");
    try {
      const response = await fetch("/api/loads/update", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Update could not run.");
      await refresh();
      setMessage(
        result.checked
          ? `Updated ${result.checked} load${result.checked === 1 ? "" : "s"}${result.deferred ? `; ${result.deferred} will continue in the background` : ""}.${result.telegramSent ? ` Sent Telegram report for ${result.telegramSent} stop${result.telegramSent === 1 ? "" : "s"}.` : " No Telegram report was sent."}${result.telegramError ? ` Telegram error: ${result.telegramError}` : ""}`
          : result.message || "No active loads need an update."
      );
    } catch (e) {
      setMessage(`Update failed: ${e.message}`);
    } finally {
      setUpdating(false);
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

  const busy = saving || loading || updating;
  const lowBalance = profile && profile.balance_cents < 200;

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
            {overCap
              ? `Over the ${maxRows}-row limit — extra rows won't save`
              : saving
              ? "Saving changes…"
              : ""}
          </span>
          <div className="toolbar-actions">
            <button className="btn ghost pale" onClick={() => setShowHelp((v) => !v)}>
              {showHelp ? "Instructions ▲" : "Instructions ▼"}
            </button>
            <button className="btn secondary" onClick={() => setShowAiImport((value) => !value)}>
              {showAiImport ? "Close AI import" : "Paste load with AI"}
            </button>
            <button className="btn secondary" onClick={updateAllNow} disabled={busy || updating}>
              {updating ? "Updating…" : "Update all now"}
            </button>
            <button className="btn secondary" onClick={clearAll} disabled={busy}>
              Clear all
            </button>
          </div>
        </div>

        {showAiImport ? (
          <div className="ai-import">
            <textarea
              className="ai-import-input"
              aria-label="Paste full load information"
              placeholder="Paste the complete load message here, including PU and DEL details…"
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
              rows={7}
            />
            <div className="ai-import-actions">
              <span className="field-hint">
                AI will add each pickup and delivery as a board row. Add a truck
                number or Samsara/Motive share link, then turn on Track to start
                scheduled checks.
              </span>
              <button className="btn" onClick={importWithAi} disabled={aiParsing || busy}>
                {aiParsing ? "Reading…" : "Read and add stops"}
              </button>
            </div>
          </div>
        ) : null}

        {showHelp ? <Instructions /> : null}

        {/* Checking can take a minute or two. Without a visible working state
            users assume the save failed and hammer the button. Only shown for
            rows that have actually been saved — see `checking`. */}
        {checking ? (
          <p className="paste-result working" role="status" aria-live="polite">
            <span className="spinner large" aria-hidden="true" />
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
                <th className="col-motion">Motion</th>
                <th className="col-status">Status</th>
                <th className="col-checkin">Check-in</th>
                <th>Link or truck #</th>
                <th className="col-load-number">Load #</th>
                <th className="col-stop">STOP / APPT</th>
                <th className="col-mail">Track / Remind</th>
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
                  !!r.tracking_enabled &&
                  !!r.id &&
                  !!r.source &&
                  !!r.deadline &&
                  (r.status === "unknown" ||
                    (!!r.next_check_at && new Date(r.next_check_at) <= new Date()));
                const zone = tzAbbr(r.dest_tz, r.appt_at || r.deadline);
                const showZone = !!zone || !!r.destination;
                const zoneHint = zone
                  ? `Times are local to the delivery (${r.dest_tz}), not your own clock.`
                  : "The destination time zone will appear after its address is resolved.";
                return (
                  <tr
                    key={r.client_key}
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
                    <td className="col-motion">
                      {r.motion ? (
                        <span
                          className={`motion-value ${
                            r.motion === "Stopped" ? "stopped" : ""
                          } ${motionStale(r.motion_updated_at) ? "stale" : ""}`}
                          title={
                            r.motion_updated_at
                              ? `Last motion reading ${new Date(r.motion_updated_at).toLocaleString()}`
                              : "Motion has not been reported yet"
                          }
                        >
                          {r.motion}
                          {motionStale(r.motion_updated_at) ? " · stale" : ""}
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
                        // Leads with the link shape, matching the column: it is
                        // the harder of the two to get right, and seeing the
                        // expected form is what stops a truncated paste.
                        placeholder="https://cloud... or 3040"
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
                    <td className="col-load-number">
                      <input
                        className="load-number-input"
                        aria-label={`Load number for row ${i + 1}`}
                        placeholder="Load #"
                        value={r.load_number}
                        onChange={(e) => update(i, "load_number", e.target.value)}
                      />
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
                        <details className="stop-full-info">
                          <summary>
                            Stop info
                            {r.source && !r.appt_at ? (
                              <span className="stop-time-warning"> · appointment time required</span>
                            ) : null}
                          </summary>
                          <div className="stop-full-fields">
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
                              {showZone ? (
                                <span className="tz-tag" title={zoneHint}>
                                  {zone || "Zone pending"}
                                </span>
                              ) : null}
                            </div>
                            <div className="alert-deadline">
                              <span>ALERT IF</span>
                              <div className="alert-cell">
                                <input
                                  className="small"
                                  type="datetime-local"
                                  value={r.deadline}
                                  onChange={(e) => update(i, "deadline", e.target.value)}
                                />
                                {showZone ? (
                                  <span className="tz-tag" title={zoneHint}>
                                    {zone || "Zone pending"}
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
                            </div>
                            <input
                              className="facility-input"
                              placeholder="Facility name"
                              value={r.name}
                              onChange={(e) => update(i, "name", e.target.value)}
                            />
                            <textarea
                              className="dest-input"
                              rows={3}
                              placeholder="Address / full stop details"
                              value={r.destination}
                              onChange={(e) =>
                                update(i, "destination", e.target.value.replace(/\s*\n\s*/g, " "))
                              }
                              onKeyDown={(e) => {
                                if (e.key === "Enter") e.preventDefault();
                              }}
                              onPaste={(e) => handleDestPaste(i, e)}
                            />
                          </div>
                        </details>
                      </div>
                    </td>
                    <td className="col-mail">
                      <MailToggle
                        label="Track"
                        hint="schedule checks and send late email alerts"
                        checked={r.tracking_enabled}
                        disabled={rowEmpty(r)}
                        onChange={(v) => setTracking(i, v)}
                      />
                      <MailToggle
                        label="Remind"
                        hint="remind me 5 min before del appt"
                        checked={r.checkin_enabled}
                        disabled={rowEmpty(r)}
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
                  <td colSpan={14} title={`More rows appear as you fill these in — up to ${maxRows}.`}>
                    <span className="more-dots">…</span>
                    <span className="more-text">
                      {maxRows - rows.length} more row
                      {maxRows - rows.length === 1 ? "" : "s"} available
                    </span>
                  </td>
                </tr>
              ) : (
                <tr className="more-row">
                  <td colSpan={14}>
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
        </div>
      </div>

      <p className="footer">
        Each tracked stop costs $2, charged once the truck arrives or the driver
        is marked checked in. Loads that never complete are never charged.
      </p>
    </div>
  );
}
