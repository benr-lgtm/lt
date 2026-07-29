"use client";

import { useState } from "react";

// Account settings. The notification email is the only required field — it's
// where every late alert goes, so an account without one is silently useless.
export default function Settings({ profile, onClose, onSaved }) {
  const [notifyEmail, setNotifyEmail] = useState(profile?.notify_email || "");
  const [fullName, setFullName] = useState(profile?.full_name || "");
  const [phone, setPhone] = useState(profile?.phone || "");
  const [checkinDefault, setCheckinDefault] = useState(!!profile?.checkin_email_default);
  const [samsaraToken, setSamsaraToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!notifyEmail.trim()) {
      setError("A notification email is required — that's where alerts go.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = {
        notify_email: notifyEmail.trim(),
        full_name: fullName.trim() || null,
        phone: phone.trim() || null,
        checkin_email_default: checkinDefault,
      };
      // Only send the token when the user actually typed one, so leaving the
      // field blank never wipes a token they already have stored.
      if (samsaraToken.trim()) body.samsara_token = samsaraToken.trim();

      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json());

      if (res.error) {
        setError(res.error);
        return;
      }
      await onSaved?.();
      onClose?.();
    } catch (err) {
      setError(err.message || "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form className="modal" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h2 className="modal-title">Settings</h2>

        <label className="auth-label" htmlFor="ne">
          Notification email <span className="req">*</span>
        </label>
        <input
          id="ne"
          className="auth-input"
          type="email"
          value={notifyEmail}
          onChange={(e) => setNotifyEmail(e.target.value)}
          required
        />

        <label className="auth-label" htmlFor="fn">
          Name <span className="opt">optional</span>
        </label>
        <input
          id="fn"
          className="auth-input"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />

        <label className="auth-label" htmlFor="ph">
          Phone <span className="opt">optional</span>
        </label>
        <input
          id="ph"
          className="auth-input"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />

        <label className="auth-label" htmlFor="st">
          Samsara API token <span className="opt">optional</span>
        </label>
        <input
          id="st"
          className="auth-input"
          type="password"
          placeholder={profile?.has_samsara_token ? "•••••••• already saved" : "only needed for truck # tracking"}
          value={samsaraToken}
          onChange={(e) => setSamsaraToken(e.target.value)}
        />
        <p className="field-hint">
          Only needed if you want to type a <b>truck number</b> instead of pasting
          a Samsara Live Share link. It comes from your own Samsara account
          (Settings → API Tokens) and lets us read that fleet&rsquo;s live GPS.
          Stored encrypted. Leave blank if you only use share links.
        </p>

        <label className="check-row">
          <input
            type="checkbox"
            checked={checkinDefault}
            onChange={(e) => setCheckinDefault(e.target.checked)}
          />
          <span>Email me check-in reminders by default on new rows</span>
        </label>

        {error ? <p className="auth-error">{error}</p> : null}

        <div className="modal-actions">
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </form>
    </div>
  );
}
