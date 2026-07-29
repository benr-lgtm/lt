"use client";

import { useEffect, useMemo, useState } from "react";
import { parseLoads } from "../lib/parseLoads";
import { getBrowserSupabase } from "../lib/supabaseBrowser";
import Instructions from "./Instructions";

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

export default function Page() {
  const [rows, setRows] = useState(() => Array.from({ length: MIN_ROWS }, (_, i) => blankRow(i)));
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [showHelp, setShowHelp] = useState(false);

  async function refresh() {
    const r = await fetch("/api/loads").then((x) => x.json());
    if (r.loads) setRows(mergeRows(r.loads));
    if (r.profile) setProfile(r.profile);
    if (r.error) setMessage("Couldn't load data: " + r.error);
  }

  useEffect(() => {
    (async () => {
      try {
        await refresh();
      } finally {
        setLoading(false);
      }
    })();
    // The server re-checks on its own schedule now, so the table just needs to
    // pick up whatever the worker has written since we last looked.
    const t = setInterval(refresh, 60000);
    return () => clearInterval(t);
  }, []);

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

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <h1 className="title">Load Tracker</h1>
          <p className="subtitle">
            Paste your load info, add the truck # or Samsara link, and we watch the
            ETA and email you if it slips past your alert time.
          </p>
        </div>
        <div className="header-right">
          {profile ? (
            <span className={"balance" + (lowBalance ? " low" : "")}>
              ${((profile.balance_cents || 0) / 100).toFixed(2)}
            </span>
          ) : null}
          <button className="btn secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="card">
        <div className="instructions-bar">
          <button className="btn ghost" onClick={() => setShowHelp((v) => !v)}>
            {showHelp ? "Hide instructions ▲" : "Instructions ▼"}
          </button>
        </div>
        {showHelp ? <Instructions /> : null}

        <div className="toolbar">
          <span className="status-line">
            {loading ? "Loading…" : `${filled} of ${maxRows} rows used`}
            {overCap ? " — over your row limit, extra rows won't save" : ""}
          </span>
          <div className="toolbar-actions">
            <button className="btn secondary" onClick={clearAll} disabled={busy}>
              Clear all
            </button>
            <button className="btn" onClick={save} disabled={busy}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>

        {lowBalance ? (
          <p className="paste-result err">
            Your balance is below $2, so new rows won&rsquo;t start tracking. Ask
            your administrator to top up.
          </p>
        ) : null}
        {message ? (
          <p className={"paste-result" + (/fail|error|couldn/i.test(message) ? " err" : "")}>
            {message}
          </p>
        ) : null}

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="col-clear" />
                <th className="col-idx">#</th>
                <th>Truck # or link</th>
                <th className="col-half">Facility name</th>
                <th>PASTE HERE 🔽</th>
                <th className="col-half">DATE &amp; TIME</th>
                <th className="col-half">ALERT IF LATE THAN…</th>
                <th className="col-loc">Last location</th>
                <th className="col-miles">Miles left</th>
                <th className="col-status">Status</th>
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
                    <td className="col-status">
                      {needsCheckin ? (
                        <div className="checkin-box">
                          <span className="checkin-label">
                            {r.checkin_state === "missed" ? "Not checked in!" : "Check in?"}
                          </span>
                          <button className="chip ok" onClick={() => checkin(r, "checked_in")}>
                            ✓ Checked IN
                          </button>
                          <button className="chip no" onClick={() => checkin(r, "missed")}>
                            ✗ Didn&rsquo;t
                          </button>
                        </div>
                      ) : (
                        <StatusBadge row={r} />
                      )}
                    </td>
                    <td>
                      <div className="notes-cell">
                        <input
                          className="notes-input"
                          placeholder="Notes"
                          value={r.notes}
                          onChange={(e) => update(i, "notes", e.target.value)}
                        />
                        <label className="checkin-toggle" title="Remind me to confirm the driver checked in">
                          <input
                            type="checkbox"
                            checked={r.checkin_enabled}
                            onChange={(e) => update(i, "checkin_enabled", e.target.checked)}
                          />
                          <span>⏰</span>
                        </label>
                      </div>
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
