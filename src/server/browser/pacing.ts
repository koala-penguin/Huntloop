/**
 * Polite pacing between page loads in the user's browser: a random 3–8 s pause by default.
 * HUNTLOOP_BROWSER_PACING_MS="min-max" overrides it ("0" turns it off, for tests).
 */
export function pacingRange(): [number, number] {
  const raw = process.env.HUNTLOOP_BROWSER_PACING_MS;
  if (raw !== undefined && raw !== "") {
    const [min, max] = raw.split("-").map(Number);
    if (Number.isFinite(min)) return [min, Number.isFinite(max) ? max : min];
  }
  return [3_000, 8_000];
}

export function pause(signal?: AbortSignal, range = pacingRange()): Promise<void> {
  const [min, max] = range;
  const ms = Math.round(min + Math.random() * Math.max(0, max - min));
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
