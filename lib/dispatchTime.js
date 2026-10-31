const STATE_ZONES = {
  AL: ["America/Chicago"], AK: ["America/Anchorage"], AZ: ["America/Phoenix"],
  AR: ["America/Chicago"], CA: ["America/Los_Angeles"], CO: ["America/Denver"],
  CT: ["America/New_York"], DE: ["America/New_York"], FL: ["America/New_York", "America/Chicago"],
  GA: ["America/New_York"], HI: ["Pacific/Honolulu"], ID: ["America/Boise", "America/Los_Angeles"],
  IL: ["America/Chicago"], IN: ["America/Indiana/Indianapolis", "America/Chicago"],
  IA: ["America/Chicago"], KS: ["America/Chicago", "America/Denver"],
  KY: ["America/New_York", "America/Chicago"], LA: ["America/Chicago"],
  ME: ["America/New_York"], MD: ["America/New_York"], MA: ["America/New_York"],
  MI: ["America/Detroit", "America/Menominee"], MN: ["America/Chicago"],
  MS: ["America/Chicago"], MO: ["America/Chicago"], MT: ["America/Denver"],
  NE: ["America/Chicago", "America/Denver"], NV: ["America/Los_Angeles", "America/Denver"],
  NH: ["America/New_York"], NJ: ["America/New_York"], NM: ["America/Denver"],
  NY: ["America/New_York"], NC: ["America/New_York"], ND: ["America/Chicago", "America/Denver"],
  OH: ["America/New_York"], OK: ["America/Chicago"], OR: ["America/Los_Angeles", "America/Boise"],
  PA: ["America/New_York"], RI: ["America/New_York"], SC: ["America/New_York"],
  SD: ["America/Chicago", "America/Denver"], TN: ["America/Chicago", "America/New_York"],
  TX: ["America/Chicago", "America/Denver"], UT: ["America/Denver"],
  VT: ["America/New_York"], VA: ["America/New_York"], WA: ["America/Los_Angeles"],
  WV: ["America/New_York"], WI: ["America/Chicago"], WY: ["America/Denver"],
};

export function appointmentHasPassed(stop, now = new Date()) {
  const appointment = stop?.appointmentAt || stop?.deadline;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(appointment || ""))) return false;
  const match = String(stop.destination || "").match(/\b([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*$/i);
  const zones = STATE_ZONES[match?.[1]?.toUpperCase()];
  if (!zones?.length) return false;

  const passedInEveryPossibleZone = zones.every((timeZone) => {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(now);
      const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
      const localNow = `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
      return appointment < localNow;
    } catch {
      return false;
    }
  });
  return passedInEveryPossibleZone;
}
