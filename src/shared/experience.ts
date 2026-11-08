import type { Experience } from "./schemas/profile";

/** Month index (years * 12 + month0) for "YYYY-MM" or "YYYY" (treated as January for starts, December for ends). */
export function monthIndex(value: string, edge: "start" | "end"): number | null {
  const m = /^(\d{4})(?:-(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = m[2] ? Number(m[2]) - 1 : edge === "start" ? 0 : 11;
  if (month < 0 || month > 11) return null;
  return year * 12 + month;
}

function nowIndex(now: Date): number {
  return now.getFullYear() * 12 + now.getMonth();
}

/**
 * Total years of experience across the given roles, merging overlapping periods so concurrent
 * roles aren't double-counted. Roles without a parseable start are ignored; a missing end means "current".
 */
export function experienceYears(roles: Pick<Experience, "start" | "end">[], now = new Date()): number {
  const ranges: Array<[number, number]> = [];
  for (const role of roles) {
    if (!role.start) continue;
    const start = monthIndex(role.start, "start");
    if (start === null) continue;
    const end = role.end ? monthIndex(role.end, "end") : nowIndex(now);
    if (end === null || end < start) continue;
    ranges.push([start, end + 1]); // end month inclusive
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let current: [number, number] | null = null;
  for (const range of ranges) {
    if (!current || range[0] > current[1]) {
      if (current) total += current[1] - current[0];
      current = [range[0], range[1]];
    } else {
      current[1] = Math.max(current[1], range[1]);
    }
  }
  if (current) total += current[1] - current[0];
  return Math.round((total / 12) * 10) / 10;
}
