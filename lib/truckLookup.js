import { normalizeTruck } from "./samsara";

export function findTruckMatches(number, fleets) {
  const key = normalizeTruck(number);
  const exact = fleets.flatMap(({ provider, vehicles }) => {
    const gps = vehicles?.get(key);
    return gps ? [{ provider, gps }] : [];
  });
  if (exact.length) return exact;
  if (!/^\d+$/.test(key)) return [];
  return fleets.flatMap(({ provider, vehicles }) =>
    [...(vehicles?.entries() || [])]
      .filter(([name]) => name.startsWith(key) && /^\s*[\p{L}]+(?:\s+[\p{L}]+)*$/u.test(name.slice(key.length)))
      .map(([, gps]) => ({ provider, gps }))
  );
}
