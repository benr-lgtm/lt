// Adaptive check scheduling.
//
// v1 re-checked every load on every run, which meant the polling rate was
// capped by the most expensive load in the table. Instead each row carries its
// own `next_check_at`, the cron sweeps only rows that are actually due, and the
// interval is chosen from how much slack is left.
//
// Slack = alert deadline − projected ETA. Small or negative slack is the only
// situation that justifies frequent checks; a load with 14 hours of room does
// not need attention every five minutes.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

export const TIERS = [
  { maxSlackMs: 15 * MIN, everyMs: 5 * MIN, label: "critical" },
  { maxSlackMs: 1 * HOUR, everyMs: 20 * MIN, label: "tight" },
  { maxSlackMs: 4 * HOUR, everyMs: 1 * HOUR, label: "near" },
  { maxSlackMs: 12 * HOUR, everyMs: 3 * HOUR, label: "far" },
  { maxSlackMs: Infinity, everyMs: 6 * HOUR, label: "distant" },
];

// Negative slack (already late) falls into the first tier by construction.
export function tierFor(slackMs) {
  const s = Number.isFinite(slackMs) ? slackMs : Infinity;
  return TIERS.find((t) => s < t.maxSlackMs) || TIERS[TIERS.length - 1];
}

/**
 * When should this row be looked at again?
 *
 * `floorMs` lets a caller raise the minimum interval — used when the CPU/quota
 * governor is degrading service, so we slow down instead of failing outright.
 * Returns null when the row is finished and should stop being scheduled.
 */
export function nextCheckAt({
  slackMs,
  arrived = false,
  done = false,
  floorMs = 0,
  now = Date.now(),
}) {
  if (arrived || done) return null;
  const tier = tierFor(slackMs);
  const every = Math.max(tier.everyMs, floorMs);
  return new Date(now + every).toISOString();
}

// How far past the deadline before we call a load late. 0 = strict.
export function graceMs() {
  return Math.max(0, parseInt(process.env.LATE_GRACE_MIN || "0", 10)) * MIN;
}

export function slackMsFrom(etaIso, deadlineIso) {
  if (!etaIso || !deadlineIso) return null;
  const eta = new Date(etaIso).getTime();
  const dl = new Date(deadlineIso).getTime();
  if (!Number.isFinite(eta) || !Number.isFinite(dl)) return null;
  return dl - eta;
}
