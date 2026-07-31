"use client";

import { useEffect, useState } from "react";

// The balance chip in the header, and the ledger that drops out of it.
//
// Loaded lazily on first open: most sessions never look at billing, and the
// ledger is the one query here that grows without bound.

const money = (cents) => {
  const v = (Math.abs(cents) / 100).toFixed(2);
  return `${cents < 0 ? "−" : ""}$${v}`;
};

// "2026-07" -> "July 2026"
function monthName(key) {
  const [y, m] = String(key).split("-").map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function when(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// What a ledger line should read as. Charges describe the stop they paid for;
// anything else falls back to whatever note was recorded.
function describe(e) {
  if (e.amount_cents >= 0) {
    return e.note || (e.kind === "bonus" ? "Signup bonus" : "Top-up");
  }
  const parts = [e.truck, e.stop, e.destination].filter(Boolean);
  return parts.length ? parts.join(" · ") : e.note || "Tracked load";
}

export default function Balance({ balanceCents }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const r = await fetch("/api/billing").then((x) => x.json());
      if (r.error) setError(r.error);
      else setData(r);
    } catch (e) {
      setError(e.message || "Couldn't load billing.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open && !data && !loading) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The header shows the profile's balance so it is correct before the panel
  // has ever been opened; once the ledger is loaded, its copy wins.
  const balance = data?.balance_cents ?? balanceCents ?? 0;
  const negative = balance < 0;
  const low = !negative && balance < 200;

  return (
    <div className="balance-wrap">
      <button
        className={"balance-btn" + (negative ? " negative" : low ? " low" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={negative ? "Balance owing — tracking continues" : "Balance and billing history"}
      >
        {money(balance)}
        <span className="balance-caret">{open ? "▲" : "▼"}</span>
      </button>

      {open ? (
        <div className="balance-panel">
          <div className="balance-panel-head">
            <div>
              <div className="balance-big">{money(balance)}</div>
              <div className="balance-sub">
                {negative
                  ? "Owing — tracking keeps running, settle when you can."
                  : "Available balance"}
              </div>
            </div>
            <button className="balance-close" onClick={() => setOpen(false)} aria-label="Close">
              ×
            </button>
          </div>

          <p className="balance-note">
            $2 per tracked stop, charged once the truck <b>arrives</b> or the
            driver is marked <b>checked in</b>. Loads that never complete are
            never charged.
          </p>

          {loading ? <p className="balance-empty">Loading…</p> : null}
          {error ? <p className="balance-empty err">{error}</p> : null}

          {data?.months?.length ? (
            <>
              <div className="balance-section">Spending</div>
              <table className="balance-months">
                <tbody>
                  {data.months.map((m) => (
                    <tr key={m.month}>
                      <td>{monthName(m.month)}</td>
                      <td className="muted">
                        {m.loads} load{m.loads === 1 ? "" : "s"}
                      </td>
                      <td className="amt out">{money(-m.spent_cents)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          {data ? (
            <>
              <div className="balance-section">Activity</div>
              {data.entries.length === 0 ? (
                <p className="balance-empty">
                  Nothing yet. Charges appear here as loads complete.
                </p>
              ) : (
                <ul className="ledger">
                  {data.entries.map((e) => (
                    <li key={e.id}>
                      <span className={"amt " + (e.amount_cents >= 0 ? "in" : "out")}>
                        {e.amount_cents >= 0 ? "+" : "−"}
                        {money(Math.abs(e.amount_cents)).replace("−", "")}
                      </span>
                      <span className="ledger-desc" title={describe(e)}>
                        {describe(e)}
                      </span>
                      <span className="ledger-when">{when(e.at)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {data.truncated ? (
                <p className="balance-empty">Showing the most recent 200 entries.</p>
              ) : null}
            </>
          ) : null}

          <p className="balance-note topup">
            Need a top-up? Contact your administrator.
          </p>
        </div>
      ) : null}
    </div>
  );
}
