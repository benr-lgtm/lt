"use client";

import { useEffect, useState } from "react";

/**
 * Light / dark switch.
 *
 * Three states rather than two: Auto follows the operating system, and it is
 * the default. A dispatcher whose machine flips to dark at sunset should get a
 * dark app without ever finding this control — and someone who explicitly
 * chooses a theme should keep it regardless of the clock.
 *
 * The actual application of the theme happens in a blocking script in
 * layout.js, before first paint. This component only records the choice; if it
 * applied it on mount the page would flash light first, which is worse in the
 * dark than never offering dark mode at all.
 */
const KEY = "truckon-theme";

export function applyTheme(pref) {
  const dark =
    pref === "dark" ||
    (pref !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

export default function ThemeToggle() {
  const [pref, setPref] = useState("auto");

  useEffect(() => {
    setPref(localStorage.getItem(KEY) || "auto");
  }, []);

  // While on Auto, follow the system if it changes mid-session — otherwise the
  // app stays light behind a machine that just went dark.
  useEffect(() => {
    if (pref !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("auto");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  function choose(next) {
    setPref(next);
    if (next === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
    applyTheme(next);
  }

  const options = [
    ["light", "☀", "Light"],
    ["dark", "☾", "Dark"],
    ["auto", "◐", "Match system"],
  ];

  return (
    <div className="theme-toggle" role="group" aria-label="Colour theme">
      {options.map(([value, glyph, label]) => (
        <button
          key={value}
          type="button"
          className={"theme-opt" + (pref === value ? " on" : "")}
          onClick={() => choose(value)}
          title={label}
          aria-label={label}
          aria-pressed={pref === value}
        >
          {glyph}
        </button>
      ))}
    </div>
  );
}
