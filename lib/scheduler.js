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

/**
 * Distance to the stop, which slack alone cannot express.
 *
 * THE FAILURE THIS FIXES. A load delivered nearly five hours early had ~5h of
 * slack, so it sat in the "far" tier and was checked every 3 hours. The truck
 * arrived at 05:19, left at 06:17 — a 58-minute visit inside a 3-hour sampling
 * gap, so the app never saw it. It then went on measuring "distance to the
 * destination" from a truck driving AWAY from a stop it had already completed:
 * 44 miles out and climbing, ETA receding, row stuck on Late. The load was on
 * time. The tracking was blind.
 *
 * Slack answers "how much trouble is this load in?". It cannot answer "is this
 * truck about to arrive?" — and a truck three miles out is about to arrive
 * whether it has ten minutes of buffer or ten hours. Early deliveries are
 * precisely the case slack scores as relaxed, so scheduling on slack alone is
 * blind exactly when it matters most.
 *
 * Note a flat interval does not fix this: a 58-minute visit sampled hourly is
 * a coin flip. Only frequency that rises with closeness does.
 */
// Never look more often than this, however close the truck gets.
export const MIN_INTERVAL_MS = 5 * MIN;
// Look again after this fraction of the remaining drive.
export const HOMING_FRACTION = 0.5;

/**
 * Homing: never schedule past the point where the truck could have arrived.
 *
 * Fixed distance bands were the obvious fix and they were not good enough —
 * simulated across every schedule phase they caught the Windsor visit 78% of
 * the time, because a truck 90 miles out still sat in a 3-hour slack tier and
 * could arrive and leave before the next look.
 *
 * Halving the remaining drive instead makes the interval collapse as the truck
 * closes: 5h out -> look in 2.5h -> 1.25h -> 38m -> 19m -> 10m -> 5m. The last
 * check before arrival therefore lands within minutes of it, whatever the
 * slack, and the schedule converges on the moment that matters instead of
 * sampling blindly through it.
 *
 * Costs roughly log2(trip / 5 min) checks for the approach — single digits for
 * any real load — because each interval is half the last.
 *
 * Returns Infinity when there is no ETA yet, so slack decides alone.
 */
export function homingIntervalMs(etaMs) {
  if (typeof etaMs !== "number" || !Number.isFinite(etaMs) || etaMs <= 0) return Infinity;
  return Math.max(MIN_INTERVAL_MS, etaMs * HOMING_FRACTION);
}

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
  etaMs = null,
  arrived = false,
  done = false,
  floorMs = 0,
  now = Date.now(),
}) {
  if (arrived || done) return null;
  // Whichever says "look sooner" wins. Slack catches loads in trouble; homing
  // catches loads about to arrive — including the early ones slack scores as
  // relaxed, which is the case that was being missed entirely.
  const every = Math.max(
    Math.min(tierFor(slackMs).everyMs, homingIntervalMs(etaMs)),
    floorMs
  );
  return new Date(now + every).toISOString();
}

// What is driving the current cadence — for diagnostics and the UI tooltip.
export function cadenceReason(slackMs, etaMs) {
  return homingIntervalMs(etaMs) < tierFor(slackMs).everyMs ? "approaching" : tierFor(slackMs).label;
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
