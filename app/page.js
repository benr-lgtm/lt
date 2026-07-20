"use client";

import { useEffect, useMemo, useState } from "react";
import { parseLoads } from "../lib/parseLoads";

const ROWS = 30;

const TIMEZONES = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"],
];

function blankRow(position) {
  return {
    position,
    name: "",
    source: "",
    kind: "delivery",
    deadline: "",
    destination: "",
    status: "unknown",
    eta_display: "",
    truck_at: "",
    status_note: "",
  };
}

function isLink(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

function mergeRows(loads) {
  const byPos = new Map((loads || []).map((l) => [l.position, l]));
  return Array.from({ length: ROWS }, (_, i) => {
    const l = byPos.get(i);
    return l
      ? {
          position: i,
          name: l.name || "",
          source: l.samsara_url || l.truck_number || "",
          kind: l.kind || "delivery",
          deadline: l.deadline || "",
          destination: l.destination || "",
          status: l.status || "unknown",
          eta_display: l.eta_display || "",
          truck_at: l.truck_at || "",
          status_note: l.status_note || "",
        }
      : blankRow(i);
  });
}

function StatusBadge({ row }) {
  const map = {
    on_time: ["ontime", "On time"],
    late: ["late", "Late"],
    error: ["error", "Check failed"],
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
    <span className={`badge ${cls}`} title={row.truck_at || ""}>
      <span className="dot" />
      {label}
      {sub ? <span className="eta-note">{sub}</span> : null}
    </span>
  );
}

export default function Page() {
  const [rows, setRows] = useState(() =>
    Array.from({ length: ROWS }, (_, i) => blankRow(i))
  );
  const [timezone, setTimezone] = useState("America/Chicago");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteMsg, setPasteMsg] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const [lr, sr] = await Promise.all([
          fetch("/api/loads").then((r) => r.json()),
          fetch("/api/settings").then((r) => r.json()),
        ]);
        if (lr.loads) setRows(mergeRows(lr.loads));
        if (sr.timezone) setTimezone(sr.timezone);
      } catch (e) {
        setMessage("Could not load data. Check your Supabase env vars.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filledCount = useMemo(
    () => rows.filter((r) => r.source && r.deadline).length,
    [rows]
  );

  function update(i, field, value) {
    setRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], [field]: value };
      return next;
    });
  }

  function applyPaste() {
    const parsed = parseLoads(pasteText);
    if (!parsed.length) {
      setPasteMsg("No loads found — check the format and try again.");
      return;
    }
    let added = 0;
    let assumed = 0;
    setRows((prev) => {
      const next = prev.slice();
      let pi = 0;
      for (let i = 0; i < next.length && pi < parsed.length; i++) {
        const r = next[i];
        const empty = !r.name && !r.source && !r.destination && !r.deadline;
        if (!empty) continue;
        const p = parsed[pi++];
        if (p.timeAssumed) assumed++;
        next[i] = {
          ...r,
          name: p.notes || "",
          kind: p.kind,
          deadline: p.deadline || "",
          destination: p.destination || "",
        };
        added++;
      }
      return next;
    });
    const leftover = parsed.length - added;
    let msg = `Added ${added} load${added === 1 ? "" : "s"}. Now fill in the truck # or link for each, then Save.`;
    if (assumed)
      msg += ` ${assumed} had no time — set to 23:59; adjust if needed.`;
    if (leftover > 0) msg += ` ${leftover} didn't fit (table is full).`;
    setPasteMsg(msg);
    setPasteText("");
    setPasteOpen(false);
  }

  async function save() {
    setSaving(true);
    setMessage("");
    try {
      const payload = rows.map((r) => ({
        position: r.position,
        name: r.name,
        kind: r.kind,
        deadline: r.deadline,
        source: r.source,
        destination: r.destination,
      }));
      const [lr] = await Promise.all([
        fetch("/api/loads", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows: payload }),
        }).then((r) => r.json()),
        fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timezone }),
        }),
      ]);
      if (lr.loads) setRows(mergeRows(lr.loads));
      setMessage("Saved.");
    } catch (e) {
      setMessage("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function checkNow() {
    setChecking(true);
    setMessage("Checking live ETAs…");
    try {
      await save();
      const res = await fetch("/api/check").then((r) => r.json());
      const lr = await fetch("/api/loads").then((r) => r.json());
      if (lr.loads) setRows(mergeRows(lr.loads));
      setMessage(
        res.checked != null
          ? `Checked ${res.checked} load(s).`
          : res.error || "Check finished."
      );
    } catch (e) {
      setMessage("Check failed: " + e.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <h1 className="title">Load Tracker</h1>
          <p className="subtitle">
            Per load, enter a <b>truck #</b> (if it&rsquo;s on your Samsara API)
            or paste a <b>Live Share link</b>, plus the deadline. We track the
            ETA and email you if it slips past the deadline.
          </p>
        </div>
        <div className="settings-box">
          <div className="tz-box">
            <label htmlFor="tz">Deadline time zone</label>
            <select
              id="tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
            >
              {TIMEZONES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <span className="status-line">
            {loading
              ? "Loading…"
              : `${filledCount} load${filledCount === 1 ? "" : "s"} being tracked`}
          </span>
          <div className="toolbar-actions">
            <button
              className="btn secondary"
              onClick={() => {
                setPasteMsg("");
                setPasteOpen((v) => !v);
              }}
            >
              {pasteOpen ? "Close" : "Paste loads"}
            </button>
            <button
              className="btn secondary"
              onClick={checkNow}
              disabled={checking || saving || loading}
            >
              {checking ? "Checking…" : "Check now"}
            </button>
          </div>
        </div>

        {pasteOpen && (
          <div className="paste-panel">
            <p className="paste-help">
              Paste one or more load blocks (like your dispatch notes). Each block
              should start with <b>Delivery/DEL</b> or <b>Pickup/PU</b> and a date,
              then the address. We&rsquo;ll fill the DEL/PU, date &amp; time,
              destination, and notes — you just add the truck # or link.
            </p>
            <textarea
              className="paste-area"
              placeholder={
                "Delivery: 07/20/26 07:00\nNAFA EXPRESS\n8909 McGaw Ct\nColumbia, MD 21045\n\nPU: 07/17/2026 0800 AM\n..."
              }
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              rows={8}
            />
            <div className="paste-actions">
              <button className="btn" onClick={applyPaste} disabled={!pasteText.trim()}>
                Add to table
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  setPasteOpen(false);
                  setPasteText("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {pasteMsg && !pasteOpen ? (
          <p className="paste-result">{pasteMsg}</p>
        ) : null}

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="col-idx">#</th>
                <th>Notes (optional)</th>
                <th>Truck # or Live Share link</th>
                <th>Destination</th>
                <th>DEL / PU date &amp; time</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="col-idx">{i + 1}</td>
                  <td>
                    <input
                      className="cell-input"
                      placeholder="(auto-filled from paste)"
                      value={r.name}
                      onChange={(e) => update(i, "name", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="source-input"
                      placeholder="3040  —or—  https://cloud.samsara.com/…/viewer/…"
                      value={r.source}
                      onChange={(e) => update(i, "source", e.target.value)}
                    />
                  </td>
                  <td>
                    <input
                      className="dest-input"
                      placeholder={
                        isLink(r.source)
                          ? "(in the link)"
                          : "Address, city, state"
                      }
                      value={r.destination}
                      disabled={isLink(r.source)}
                      onChange={(e) => update(i, "destination", e.target.value)}
                    />
                  </td>
                  <td>
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
                        type="datetime-local"
                        value={r.deadline}
                        onChange={(e) => update(i, "deadline", e.target.value)}
                      />
                    </div>
                  </td>
                  <td>
                    <StatusBadge row={r} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="savebar">
          <span className="save-note">{message}</span>
          <button className="btn" onClick={save} disabled={saving || loading}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <p className="footer">
        Statuses refresh automatically every few minutes. “Check now” refreshes
        immediately.
      </p>
    </div>
  );
}
