"use client";

import { useEffect, useState } from "react";

function money(cents) {
  return `$${((cents || 0) / 100).toFixed(2)}`;
}

export default function AdminPage() {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [created, setCreated] = useState(null);

  async function load() {
    const r = await fetch("/api/admin").then((x) => x.json());
    setData(r);
  }
  useEffect(() => {
    load();
  }, []);

  async function post(payload, okMsg) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/admin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).then((x) => x.json());
      if (r.error) {
        setMsg(r.error);
        return null;
      }
      setMsg(okMsg || "Done.");
      await load();
      return r;
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <div className="wrap"><p>Loading…</p></div>;
  if (data.error) return <div className="wrap"><p className="auth-error">{data.error}</p></div>;

  const usage = data.usage || {};

  return (
    <div className="wrap">
      <div className="header">
        <div>
          <h1 className="title">Admin</h1>
          <p className="subtitle">
            {data.users.length} user{data.users.length === 1 ? "" : "s"} · invite-only
          </p>
        </div>
      </div>

      {msg ? <p className="paste-result">{msg}</p> : null}

      <div className="card">
        <h2 className="section-title">Today&rsquo;s provider usage</h2>
        <div className="usage-grid">
          {["ors", "mapbox", "nominatim", "google"].map((p) => {
            const u = usage[p] || { used: 0, cap: "—" };
            const pct = Number.isFinite(u.cap) && u.cap > 0 ? (u.used / u.cap) * 100 : 0;
            return (
              <div key={p} className="usage-item">
                <div className="usage-name">{p}</div>
                <div className="usage-num">
                  {u.used} <span className="usage-cap">/ {u.cap}</span>
                </div>
                <div className="usage-bar">
                  <div
                    className={"usage-fill" + (pct > 80 ? " hot" : "")}
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <p className="hint">
          Samsara GraphQL (Tier 1) success:{" "}
          <b>{data.graphqlHealth == null ? "no data yet" : `${data.graphqlHealth}%`}</b>
          {data.graphqlHealth != null && data.graphqlHealth < 80
            ? " — a sustained drop means Samsara changed their API."
            : ""}
        </p>
      </div>

      <div className="card">
        <h2 className="section-title">Create user</h2>
        <div className="admin-row">
          <input
            className="cell-input"
            placeholder="email@company.com *"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
          />
          <input
            className="cell-input"
            placeholder="Name (optional)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            className="cell-input"
            placeholder="Phone (optional)"
            value={newPhone}
            onChange={(e) => setNewPhone(e.target.value)}
          />
          <button
            className="btn"
            disabled={busy || !newEmail}
            onClick={async () => {
              const r = await post(
                { action: "createUser", email: newEmail, fullName: newName, phone: newPhone },
                "User created."
              );
              if (r?.ok) {
                setCreated(r);
                setNewEmail("");
                setNewName("");
                setNewPhone("");
              }
            }}
          >
            Create
          </button>
        </div>
        {created ? (
          <div className="created-box">
            <p>
              <b>{created.email}</b> created with a ${created.bonus} bonus.
            </p>
            <p>
              Temporary password: <code>{created.password}</code>
            </p>
            <p className="hint">
              Shown once — copy it now and send it to them over a channel you trust.
            </p>
          </div>
        ) : null}
      </div>

      <div className="card">
        <h2 className="section-title">Users</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name / phone</th>
                <th>Balance</th>
                <th>Rows</th>
                <th>Active</th>
                <th>Paid</th>
                <th>Max rows</th>
                <th title="That user's own Samsara API token, so they can track by truck # instead of pasting a Live Share link. Not a password — it comes from their Samsara account under Settings → API Tokens. Stored encrypted.">
                  Samsara API token ⓘ
                </th>
                <th>Top up</th>
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <UserRow key={u.id} u={u} post={post} busy={busy} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="footer">
        <button
          className="btn secondary"
          onClick={async () => {
            await fetch("/api/admin/login", { method: "DELETE" });
            window.location.href = "/admin/login";
          }}
        >
          Sign out of admin
        </button>
      </p>
    </div>
  );
}

function UserRow({ u, post, busy }) {
  const [amount, setAmount] = useState("");
  const [token, setToken] = useState("");
  const [maxRows, setMaxRows] = useState(u.max_rows);

  return (
    <tr>
      <td>{u.email}</td>
      <td className="muted">
        {u.full_name || "—"}
        {u.phone ? <div className="sub">{u.phone}</div> : null}
      </td>
      <td className={u.balance_cents < 200 ? "bal-low" : ""}>{money(u.balance_cents)}</td>
      <td>{u.stats.rows}</td>
      <td>{u.stats.active}</td>
      <td>{u.stats.paid}</td>
      <td>
        <input
          className="cell-input tiny"
          value={maxRows}
          onChange={(e) => setMaxRows(e.target.value)}
          onBlur={() =>
            String(maxRows) !== String(u.max_rows) &&
            post({ action: "setMaxRows", userId: u.id, maxRows }, "Row cap updated.")
          }
        />
      </td>
      <td>
        <input
          className="cell-input"
          type="password"
          placeholder={u.samsara_token_enc ? "•••• set" : "paste token"}
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <button
          className="btn secondary tiny-btn"
          disabled={busy}
          onClick={() => {
            post({ action: "setSamsaraToken", userId: u.id, token }, "Token saved.");
            setToken("");
          }}
        >
          Save
        </button>
      </td>
      <td>
        <input
          className="cell-input tiny"
          placeholder="$"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button
          className="btn tiny-btn"
          disabled={busy || !amount}
          onClick={() => {
            post({ action: "topup", userId: u.id, amount }, `Credited ${u.email}.`);
            setAmount("");
          }}
        >
          Add
        </button>
      </td>
    </tr>
  );
}
