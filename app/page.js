"use client";

import { useEffect, useMemo, useState } from "react";
import { parseLoads } from "../lib/parseLoads";

const MIN_ROWS = 15; // table never shows fewer rows than this
const SPARE_ROWS = 5; // empty rows always kept below the last filled one

function blankRow(position) {
  return {
    position,
    name: "",
    source: "",
    kind: "delivery",
    deadline: "",
    destination: "",
    notes: "",
    status: "unknown",
    eta_display: "",
    truck_at: "",
    status_note: "",
  };
}

function isLink(s) {
  return /^https?:\/\//i.test(String(s || "").trim());
}

function rowEmpty(r) {
  return !r.name && !r.source && !r.destination && !r.deadline && !r.notes;
}

// Keep SPARE_ROWS empty rows after the last filled row (and at least MIN_ROWS
// total). Positions are re-stamped to the row index.
function withSpare(list) {
  let lastFilled = -1;
  list.forEach((r, i) => {
    if (!rowEmpty(r)) lastFilled = i;
  });
  const size = Math.max(MIN_ROWS, lastFilled + 1 + SPARE_ROWS);
  const next = [];
  for (let i = 0; i < size; i++) {
    next.push(list[i] ? { ...list[i], position: i } : blankRow(i));
  }
  return next;
}

function mergeRows(loads) {
  const byPos = new Map((loads || []).map((l) => [l.position, l]));
  const maxPos = Math.max(-1, ...(loads || []).map((l) => l.position));
  const base = Array.from({ length: Math.max(MIN_ROWS, maxPos + 1) }, (_, i) => {
    const l = byPos.get(i);
    return l
      ? {
          position: i,
          name: l.name || "",
          source: l.samsara_url || l.truck_number || "",
          kind: l.kind || "delivery",
          deadline: l.deadline || "",
          destination: l.destination || "",
          notes: l.notes || "",
          status: l.status || "unknown",
          eta_display: l.eta_display || "",
          truck_at: l.truck_at || "",
          status_note: l.status_note || "",
        }
      : blankRow(i);
  });
  return withSpare(base);
}

function StatusBadge({ row }) {
  const map = {
    on_time: ["ontime", "On time"],
    late: ["late", "Late"],
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
  const tooltip = [sub, row.truck_at].filter(Boolean).join(" — ");
  return (
    <span className={`badge ${cls}`} title={tooltip}>
      <span className="dot" />
      <span className="badge-text">
        {label}
        {sub ? <span className="eta-note">{sub}</span> : null}
      </span>
    </span>
  );
}

export default function Page() {
  const [rows, setRows] = useState(() =>
    Array.from({ length: MIN_ROWS }, (_, i) => blankRow(i))
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const lr = await fetch("/api/loads").then((r) => r.json());
        if (lr.loads) setRows(mergeRows(lr.loads));
        else if (lr.error)
          setMessage("Couldn't load data: " + lr.error + " — see /api/health.");
      } catch (e) {
        setMessage("Could not load data. Check setup at /api/health.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const filledCount = useMemo(
    () => rows.filter((r) => r.source && r.deadline).length,
    [rows]
  );

  function clearRow(i) {
    setRows((prev) => {
      const next = prev.slice();
      next[i] = blankRow(next[i].position);
      return withSpare(next);
    });
    setMessage("Row cleared — it's removed from the database on the next Save & Check.");
  }

  async function clearAll() {
    if (
      !window.confirm(
        "Clear ALL rows? This deletes every load from the tracker and cannot be undone."
      )
    )
      return;
    setSaving(true);
    setMessage("Clearing…");
    try {
      const res = await fetch("/api/loads", { method: "DELETE" }).then((r) =>
        r.json()
      );
      if (res.error) {
        setMessage("Clear failed: " + res.error);
        return;
      }
      setRows(Array.from({ length: MIN_ROWS }, (_, i) => blankRow(i)));
      setMessage("All loads cleared.");
    } catch (e) {
      setMessage("Clear failed: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  function update(i, field, value) {
    setRows((prev) => {
      const next = prev.slice();
      next[i] = { ...next[i], [field]: value };
      return withSpare(next);
    });
  }

  // Paste dispatch blocks (PU/DEL + address) straight into a Destination cell.
  // The first block fills this row (keeping its truck #), remaining blocks
  // flow into the next empty rows. A plain address pastes normally.
  function handleDestPaste(i, e) {
    const text = e.clipboardData ? e.clipboardData.getData("text") : "";
    const parsed = parseLoads(text);
    if (!parsed.length) return; // normal paste
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
          deadline: p.deadline || "",
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
    let msg = `Added ${parsed.length} load${parsed.length === 1 ? "" : "s"} from paste. Add the truck # or link where missing, then Save & Check.`;
    if (assumed) msg += ` ${assumed} had no time — set to 23:59; adjust if needed.`;
    setMessage(msg);
  }

  async function save() {
    setSaving(true);
    try {
      const payload = rows.map((r) => ({
        position: r.position,
        name: r.name,
        kind: r.kind,
        deadline: r.deadline,
        source: r.source,
        destination: r.destination,
        notes: r.notes,
      }));
      const lr = await fetch("/api/loads", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: payload }),
      }).then((r) => r.json());
      if (lr.error) {
        setMessage("Save failed: " + lr.error + " — check /api/health.");
        return false;
      }
      if (lr.loads) setRows(mergeRows(lr.loads));
      return true;
    } catch (e) {
      setMessage("Save failed: " + e.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveAndCheck() {
    setChecking(true);
    setMessage("Saving…");
    try {
      const ok = await save();
      if (!ok) return;
      setMessage("Saved. Checking live ETAs…");
      const res = await fetch("/api/check").then((r) => r.json());
      const lr = await fetch("/api/loads").then((r) => r.json());
      if (lr.loads) setRows(mergeRows(lr.loads));
      setMessage(
        res.checked != null
          ? `Saved & checked ${res.checked} load(s).`
          : res.error || "Saved. Check finished."
      );
    } catch (e) {
      setMessage("Check failed: " + e.message);
    } finally {
      setChecking(false);
    }
  }

  const busy = checking || saving || loading;

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <h1 className="title">Load Tracker</h1>
          <p className="subtitle">
            Per load, enter a <b>truck #</b> (if it&rsquo;s on your Samsara API)
            or paste a <b>Live Share link</b>, plus the deadline. You can paste
            whole dispatch blocks (PU/DEL + address) straight into a{" "}
            <b>Destination</b> cell — each block becomes a row. Deadlines are
            read in the <b>destination&rsquo;s local time</b>, and we email you
            if the ETA slips past it.
          </p>
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
            <button className="btn secondary" onClick={clearAll} disabled={busy}>
              Clear all
            </button>
            <button className="btn" onClick={saveAndCheck} disabled={busy}>
              {checking ? "Working…" : "Save & Check"}
            </button>
          </div>
        </div>

        {message ? (
          <p
            className={
              "paste-result" +
              (/fail|error|couldn|could not/i.test(message) ? " err" : "")
            }
          >
            {message}
          </p>
        ) : null}

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th className="col-clear" aria-label="Clear row" />
                <th className="col-idx">#</th>
                <th>Truck # or link</th>
                <th>Facility name</th>
                <th>Destination</th>
                <th>DEL / PU date &amp; time</th>
                <th className="col-status">Status</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="col-clear">
                    {!rowEmpty(r) ? (
                      <button
                        className="clear-btn"
                        title="Clear this row"
                        onClick={() => clearRow(i)}
                      >
                        ×
                      </button>
                    ) : null}
                  </td>
                  <td className="col-idx">{i + 1}</td>
                  <td>
                    <input
                      className="source-input"
                      placeholder="3040 or link"
                      value={r.source}
                      onChange={(e) => update(i, "source", e.target.value)}
                    />
                  </td>
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
                      className="dest-input"
                      placeholder={
                        isLink(r.source)
                          ? "(in the link)"
                          : "Address — or paste PU/DEL blocks here"
                      }
                      value={r.destination}
                      disabled={isLink(r.source)}
                      onChange={(e) => update(i, "destination", e.target.value)}
                      onPaste={(e) => handleDestPaste(i, e)}
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
                  <td className="col-status">
                    <StatusBadge row={r} />
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
              ))}
            </tbody>
          </table>
        </div>

        <div className="savebar">
          <span className="save-note">{message}</span>
          <button className="btn secondary" onClick={clearAll} disabled={busy}>
            Clear all
          </button>
          <button className="btn" onClick={saveAndCheck} disabled={busy}>
            {checking ? "Working…" : "Save & Check"}
          </button>
        </div>
      </div>

      <p className="footer">
        Statuses refresh automatically every few minutes. &ldquo;Save &amp;
        Check&rdquo; saves the table and refreshes live ETAs immediately.
      </p>
    </div>
  );
}
