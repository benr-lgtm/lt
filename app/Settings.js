"use client";

import { useState } from "react";

// Account settings.
//
// The registered email (the login) is shown read-only and is deliberately NOT
// the alert address: people sign up with an admin mailbox but want alerts in a
// dispatch inbox. It seeds the alert field on first open and is otherwise left
// alone. Every alert address carries its own alert/remind flags so a customer
// can hear that a load is late without receiving internal check-in nags.
export default function Settings({ profile, onClose, onSaved }) {
  const registeredEmail = profile?.email || "";
  const [notifyEmail, setNotifyEmail] = useState(
    profile?.notify_email || registeredEmail || ""
  );
  const [notifyAlert, setNotifyAlert] = useState(profile?.notify_alert !== false);
  const [notifyRemind, setNotifyRemind] = useState(profile?.notify_remind !== false);
  const [cc1, setCc1] = useState({
    email: profile?.cc1_email || "",
    alert: profile?.cc1_alert !== false,
    remind: !!profile?.cc1_remind,
  });
  const [cc2, setCc2] = useState({
    email: profile?.cc2_email || "",
    alert: profile?.cc2_alert !== false,
    remind: !!profile?.cc2_remind,
  });
  const [fullName, setFullName] = useState(profile?.full_name || "");
  const [phone, setPhone] = useState(profile?.phone || "");
  const [checkinDefault, setCheckinDefault] = useState(!!profile?.checkin_email_default);
  const [samsaraToken, setSamsaraToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!notifyEmail.trim()) {
      setError("An alert email is required — that's where alerts go.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const body = {
        notify_email: notifyEmail.trim(),
        notify_alert: notifyAlert,
        notify_remind: notifyRemind,
        cc1_email: cc1.email.trim() || null,
        cc1_alert: cc1.alert,
        cc1_remind: cc1.remind,
        cc2_email: cc2.email.trim() || null,
        cc2_alert: cc2.alert,
        cc2_remind: cc2.remind,
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
      {/* autoComplete="off" on the form and every field: Chrome was dropping the
          account email into the Phone box (it skips the disabled registered-email
          input and fills the next text field it likes), and that guess would have
          been saved as the user's phone number on the next Save. */}
      <form
        className="modal"
        autoComplete="off"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="modal-title">Settings</h2>

        <label className="auth-label">Registered email</label>
        <input className="auth-input" type="email" value={registeredEmail} disabled readOnly />
        <p className="field-hint">
          Your sign-in address. Alerts don&rsquo;t have to go here — set the alert
          email below.
        </p>

        <label className="auth-label" htmlFor="ne">
          Alert email <span className="req">*</span>
        </label>
        <input
          id="ne"
          autoComplete="off"
          className="auth-input"
          type="email"
          value={notifyEmail}
          onChange={(e) => setNotifyEmail(e.target.value)}
          required
        />
        <MailFlags
          idPrefix="own"
          alert={notifyAlert}
          remind={notifyRemind}
          onAlert={setNotifyAlert}
          onRemind={setNotifyRemind}
        />

        <label className="auth-label" htmlFor="cc1">
          Also email <span className="opt">optional</span>
        </label>
        <input
          id="cc1"
          autoComplete="off"
          className="auth-input"
          type="email"
          placeholder="name@company.com"
          value={cc1.email}
          onChange={(e) => setCc1({ ...cc1, email: e.target.value })}
        />
        <MailFlags
          idPrefix="cc1"
          disabled={!cc1.email.trim()}
          alert={cc1.alert}
          remind={cc1.remind}
          onAlert={(v) => setCc1({ ...cc1, alert: v })}
          onRemind={(v) => setCc1({ ...cc1, remind: v })}
        />

        <label className="auth-label" htmlFor="cc2">
          Also email <span className="opt">optional</span>
        </label>
        <input
          id="cc2"
          autoComplete="off"
          className="auth-input"
          type="email"
          placeholder="name@company.com"
          value={cc2.email}
          onChange={(e) => setCc2({ ...cc2, email: e.target.value })}
        />
        <MailFlags
          idPrefix="cc2"
          disabled={!cc2.email.trim()}
          alert={cc2.alert}
          remind={cc2.remind}
          onAlert={(v) => setCc2({ ...cc2, alert: v })}
          onRemind={(v) => setCc2({ ...cc2, remind: v })}
        />
        <p className="field-hint">
          You can add your customer, carrier, and/or driver&rsquo;s email
          addresses too. Each address gets its own copy, so nobody sees the
          others&rsquo; email.
        </p>

        <label className="auth-label" htmlFor="fn">
          Name <span className="opt">optional</span>
        </label>
        <input
          id="fn"
          autoComplete="off"
          className="auth-input"
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
        />

        <label className="auth-label" htmlFor="ph">
          Phone <span className="opt">optional</span>
        </label>
        {/* autoComplete="tel" rather than "off": Chrome ignores "off" on contact
            fields and was filling this with the account email. Naming the field
            honestly makes it offer a phone number instead of guessing. The API
            also rejects an address here, since no attribute is a guarantee. */}
        <input
          id="ph"
          autoComplete="tel"
          inputMode="tel"
          type="tel"
          className="auth-input"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />

        <label className="auth-label" htmlFor="st">
          Samsara API token <span className="opt">optional</span>
        </label>
        <input
          id="st"
          autoComplete="off"
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
          <span>Tick &ldquo;remind&rdquo; by default on new rows</span>
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

// The two per-address switches. Wording matches the table's column exactly, so
// "alert" and "remind" mean the same thing in both places.
function MailFlags({ idPrefix, alert, remind, onAlert, onRemind, disabled = false }) {
  return (
    <div className={"mail-flags" + (disabled ? " disabled" : "")}>
      <label title="Alert if the ETA runs past the deadline">
        <input
          type="checkbox"
          id={`${idPrefix}-alert`}
          checked={alert && !disabled}
          disabled={disabled}
          onChange={(e) => onAlert(e.target.checked)}
        />
        <span>alert</span>
      </label>
      <label title="Remind 5 minutes before the delivery appointment">
        <input
          type="checkbox"
          id={`${idPrefix}-remind`}
          checked={remind && !disabled}
          disabled={disabled}
          onChange={(e) => onRemind(e.target.checked)}
        />
        <span>remind</span>
      </label>
    </div>
  );
}
