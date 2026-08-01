"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

// History: past loads and the billing record, in one place.
//
// This replaced a dropdown hanging off the balance chip. A dropdown is the
// wrong container for something you scroll, compare and read back over — it
// closes when you click away, cannot be linked to, and had to stay short.

const money = (cents) => {
  const v = (Math.abs(cents) / 100).toFixed(2);
  return `${cents < 0 ? "−" : ""}$${v}`;
};

function monthName(key) {
  const [y, m] = String(key).split("-").map(Number);
  if (!y || !m) return key;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

function when(iso, tz) {
  if (!iso) return "—";
  const d = new Date(String(iso).replace(" ", "T"));
  if (!Number.isFinite(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    timeZone: tz || undefined,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function describe(e) {
  if (e.amount_cents >= 0) return e.note || (e.kind === "bonus" ? "Signup bonus" : "Top-up");
  return e.note || "Tracked load";
}

const STATUS = {
  arrived: ["arrived", "Arrived"],
  late: ["late", "Late"],
  on_time: ["ontime", "On time"],
  error: ["error", "Couldn't track"],
  unpaid: ["unpaid", "Needs credit"],
  unknown: ["unknown", "—"],
};

export default function HistoryPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("loads");

  useEffect(() => {
    fetch("/api/history")
      .then((r) => r.json())
      .then((r) => (r.error ? setError(r.error) : setData(r)))
      .catch((e) => setError(e.message));
  }, []);

  const days = data?.retentionDays ?? 7;

  return (
    <div className="wrap">
      <div className="header">
        <div className="brand">
          <img src="/logo.png" alt="" width={1200} height={397} className="brand-mark" />
          <div>
            <h1 className="title">History &amp; billing</h1>
            <p className="subtitle">Past loads and every charge on this account.</p>
          </div>
        </div>
        <div className="header-right">
          {data ? (
            <span className={"balance-btn" + (data.balance_cents < 0 ? " negative" : "")}>
              {money(data.balance_cents)}
            </span>
          ) : null}
          <Link className="btn secondary" href="/">
            ← Back to loads
          </Link>
        </div>
      </div>

      <div className="card">
        <div className="toolbar">
          <div className="toolbar-actions">
            <button
              className={"btn ghost pale" + (tab === "loads" ? " on" : "")}
              onClick={() => setTab("loads")}
            >
              Past loads
            </button>
            <button
              className={"btn ghost pale" + (tab === "billing" ? " on" : "")}
              onClick={() => setTab("billing")}
            >
              Billing
            </button>
          </div>
        </div>

        {error ? <p className="paste-result err">{error}</p> : null}
        {!data && !error ? <p className="balance-empty">Loading…</p> : null}

        {data && tab === "loads" ? (
          <>
            <p className="retention-note">
              Completed and cleared loads stay here for <b>{days} days</b>, then
              they&rsquo;re removed. Your billing record is kept permanently.
            </p>
            {data.loads.length === 0 ? (
              <p className="balance-empty">
                Nothing yet. Loads appear here once they arrive or you clear them.
              </p>
            ) : (
              <div className="table-scroll">
                <table className="hist-table">
                  <thead>
                    <tr>
                      <th>Stop</th>
                      <th>Truck</th>
                      <th>Destination</th>
                      <th>Appointment</th>
                      <th>Result</th>
                      <th>Charged</th>
                      <th>Kept until</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.loads.map((l) => {
                      const [cls, label] = STATUS[l.status] || STATUS.unknown;
                      return (
                        <tr key={l.id}>
                          <td className="hist-kind">{l.kind === "pickup" ? "PU" : "DEL"}</td>
                          <td>{l.truck_number || (l.samsara_url ? "Shared link" : "—")}</td>
                          <td>
                            <div className="hist-dest">{l.destination || "—"}</div>
                            {l.name ? <div className="hist-sub">{l.name}</div> : null}
                          </td>
                          <td>{when(l.appt_at || l.deadline, l.dest_tz)}</td>
                          <td>
                            <span className={`badge ${cls}`} title={l.status_note || ""}>
                              <span className="dot" />
                              <span className="badge-text">
                                <span className="badge-label">{label}</span>
                                {l.arrived_at ? (
                                  <span className="eta-note">{when(l.arrived_at, l.dest_tz)}</span>
                                ) : null}
                              </span>
                            </span>
                            {l.checkin_state === "checked_in" ? (
                              <div className="hist-sub">✓ checked in</div>
                            ) : null}
                          </td>
                          <td className={l.charged_at ? "amt out" : "muted"}>
                            {l.charged_at ? "−$2.00" : "—"}
                          </td>
                          <td className="muted">
                            {l.cleared ? `cleared · ${l.expiresInDays}d left` : "on the board"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}

        {data && tab === "billing" ? (
          <>
            <p className="retention-note">
              $2 per stop, charged once the truck <b>arrives</b> or the driver is
              marked <b>checked in</b>. Loads that never complete are never
              charged. This record is kept permanently.
            </p>

            <div className="balance-section pad">Monthly summary</div>
            {data.months.length === 0 ? (
              <p className="balance-empty">No activity yet.</p>
            ) : (
              <div className="table-scroll">
                <table className="hist-table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Loads</th>
                      <th>Spent</th>
                      <th>Topped up</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.months.map((m) => (
                      <tr key={m.month}>
                        <td>{monthName(m.month)}</td>
                        <td>{m.loads}</td>
                        <td className="amt out">{money(-m.spent_cents)}</td>
                        <td className="amt in">
                          {m.topped_up_cents ? money(m.topped_up_cents) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="balance-section pad">Every transaction</div>
            <div className="table-scroll">
              <table className="hist-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Amount</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.id}>
                      <td className="muted">{when(e.created_at)}</td>
                      <td className={"amt " + (e.amount_cents >= 0 ? "in" : "out")}>
                        {e.amount_cents >= 0 ? "+" : "−"}
                        {money(Math.abs(e.amount_cents)).replace("−", "")}
                      </td>
                      <td>{describe(e)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>

      <p className="footer">
        Need a top-up? Contact your administrator.
      </p>
    </div>
  );
}
