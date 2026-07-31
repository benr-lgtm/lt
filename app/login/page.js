"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { getBrowserSupabase } from "../../lib/supabaseBrowser";

const SIGNUP_EMAIL = "bakhtiyor1chi@gmail.com";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  async function copyEmail() {
    try {
      await navigator.clipboard.writeText(SIGNUP_EMAIL);
    } catch {
      // clipboard API needs HTTPS + permission; fall back to selecting the text
      // so the visitor can still copy it by hand rather than hitting a dead end.
      const el = document.getElementById("signup-email");
      if (el) {
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const supabase = getBrowserSupabase();
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        setError(error.message);
        return;
      }
      router.replace("/");
      router.refresh();
    } catch (err) {
      setError(err.message || "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <form className="auth-card" onSubmit={submit}>
        <img src="/logo.png" alt="" width={1200} height={397} className="auth-mark" />
        <h1 className="auth-title">TruckOn.site</h1>
        <p className="auth-sub">Sign in to see your loads.</p>

        <label className="auth-label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="auth-input"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />

        <label className="auth-label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="auth-input"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />

        {error ? <p className="auth-error">{error}</p> : null}

        <button className="btn auth-btn" disabled={busy} type="submit">
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <p className="auth-note">
          Accounts are created by invitation. Contact your administrator if you
          need access.
        </p>
      </form>

      {/* Outside the <form> on purpose: a <button> inside it would submit the
          sign-in form on Enter, and the mailto link would look like a login
          attempt. */}
      <div className="signup-cta">
        <p className="signup-cta-text">
          Email me to get new account credentials and a{" "}
          <b>$50 signup bonus</b>:
        </p>
        <a id="signup-email" className="signup-email" href={`mailto:${SIGNUP_EMAIL}`}>
          {SIGNUP_EMAIL}
        </a>
        <button type="button" className="btn secondary copy-btn" onClick={copyEmail}>
          {copied ? "Copied ✓" : "Copy email"}
        </button>
      </div>
    </div>
  );
}
