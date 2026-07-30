"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { parseLoads } from "../lib/parseLoads";
import { getBrowserSupabase } from "../lib/supabaseBrowser";
import Instructions from "./Instructions";
import Settings from "./Settings";

const MIN_ROWS = 15;
const SPARE_ROWS = 5;

function blankRow(position) {
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
  };
}

const isLink = (s) => /^https?:\/\//i.test(String(s || "").trim());
const rowEmpty = (r) =>
  !r.name && !r.source && !r.destination && !r.deadline && !r.appt_at && !r.notes;

function withSpare(list) {
  let lastFilled = -1;
  list.forEach((r, i) => {
    if (!rowEmpty(r)) lastFilled = i;
  });
  const size = Math.max(MIN_ROWS, lastFilled + 1 + SPARE_ROWS);
  const next = [];
  for (let i = 0; i < size; i++) next.push(list[i] ? { ...list[i], position: i } : blankRow(i));
  return next;
}

function mergeRows(loads) {
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
    };
  });
  return withSpare(base);
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
  const sub =
    row.status === "error"
      ? row.status_note
      : row.eta_display
      ? `ETA ${row.eta_display}`
      : "";
  return (
    <span className={`badge ${cls}`} title={[sub, row.truck_at].filter(Boolean).join(" — ")}>
      <span className="dot" />
      <span className="badge-text">
        {label}
        {sub ? <span className="eta-note">{sub}</span> : null}
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

  async function refresh() {
    const r = await fetch("/api/loads").then((x) => x.json());
    if (r.loads) setRows(mergeRows(r.loads));
    if (r.profile) setProfile(r.profile);
    if (r.error) setMessage("Couldn't load data: " + r.error);
  }

  // A row that has everything it needs but no result yet is still being worked
  // on by the background checker. Deriving this from the data (rather than a
  // manual flag) means the banner clears itself the moment a result lands.
  const checking = useMemo(
    () => rows.some((r) => r.source && r.deadline && r.status === "unknown"),
    [rows]
  );

  useEffect(() => {
    (async () => {
      try {
        await refresh();
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
  const maxRows = profile?.max_rows ?? 30;
  const overCap = filled > maxRows;

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
      return withSpare(next);
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
      return withSpare(next);
    });
    setMessage("Row cleared — it leaves the database on the next save.");
  }

  async function clearAll() {
    if (!window.confirm("Clear ALL rows? This cannot be undone.")) return;
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
      return withSpare(next);
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
      const res = await fetch("/api/loads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      }).then((r) => r.json());
      if (res.error) return setMessage("Save failed: " + res.error);
      if (res.loads) setRows(mergeRows(res.loads));
      if (res.profile) setProfile(res.profile);
      setMessage("Saved. Tracking runs automatically — no need to press anything again.");
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
        <div>
          <h1 className="title">TruckOn.site</h1>
          <p className="subtitle">
            Let us monitor your loads and alert you as soon as ETA is delayed.
          </p>
        </div>
        <div className="header-right">
          {profile ? (
            <span className={"balance" + (lowBalance ? " low" : "")}>
              ${((profile.balance_cents || 0) / 100).toFixed(2)}
            </span>
          ) : null}
          <button className="btn secondary" onClick={() => setShowSettings(true)}>
            Settings
          </button>
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
          <span className="status-line">
            {loading ? "Loading…" : `${filled} of ${maxRows} rows used`}
            {overCap ? " — over your row limit, extra rows won't save" : ""}
          </span>
          <div className="toolbar-actions">
            <button className="btn ghost pale" onClick={() => setShowHelp((v) => !v)}>
              {showHelp ? "Instructions ▲" : "Instructions ▼"}
            </button>
            <button className="btn secondary" onClick={clearAll} disabled={busy}>
              Clear all
            </button>
            <button className="btn" onClick={save} disabled={busy}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {showHelp ? <Instructions /> : null}

        {/* Checking can take a minute or two. Without a visible working state
            users assume the save failed and hammer the button. */}
        {checking ? (
          <p className="paste-result working">
            <span className="spinner" />
            Working on it — finding your trucks and calculating ETAs. This can take
            a minute or two, and updates appear on their own. No need to press
            anything.
          </p>
        ) : null}

        {lowBalance ? (
          <p className="paste-result err">
            Your balance is below $2, so new rows won&rsquo;t start tracking. Ask
            your administrator to top up.
          </p>
        ) : null}
        {message && !checking ? (
          <p className={"paste-result" + (/fail|error|couldn/i.test(message) ? " err" : "")}>
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
                <th className="col-miles">Miles left</th>
                <th className="col-status">Status</th>
                <th className="col-checkin">Check-in</th>
                <th>Truck # or link</th>
                <th className="col-half">Facility name</th>
                <th>PASTE HERE 🔽</th>
                <th className="col-half">DATE &amp; TIME</th>
                <th className="col-half">ALERT IF LATE THAN…</th>
                <th className="col-mail">Email alerts</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const needsCheckin = r.checkin_state === "due" || r.checkin_state === "missed";
                return (
                  <tr
                    key={i}
                    className={
                      (r.checkin_state === "missed" ? "row-missed " : "") +
                      (r.checkin_state === "due" ? "row-checkin " : "")
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
                        className="source-input"
                        placeholder="3040 or Samsara link"
                        value={r.source}
                        onChange={(e) => update(i, "source", e.target.value)}
                      />
                    </td>
                    <td className="col-half">
                      <input
                        className="cell-input small"
                        placeholder="(from paste)"
                        value={r.name}
                        onChange={(e) => update(i, "name", e.target.value)}
                      />
                    </td>
                    <td>
                      <input
                        className="dest-input"
                        placeholder="Paste the whole load block here"
                        value={r.destination}
                        onChange={(e) => update(i, "destination", e.target.value)}
                        onPaste={(e) => handleDestPaste(i, e)}
                      />
                    </td>
                    <td className="col-half">
                      <div className="deadline-cell">
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
            </tbody>
          </table>
        </div>

        <div className="savebar">
          <span className="save-note">{message}</span>
          <button className="btn secondary" onClick={clearAll} disabled={busy}>
            Clear all
          </button>
          <button className="btn" onClick={save} disabled={busy}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <p className="footer">
        Each tracked row costs $2 and is charged once, covering it from the first
        check until the truck arrives.
      </p>
    </div>
  );
}

