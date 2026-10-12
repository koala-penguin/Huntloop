/** JSON with object keys sorted, so equal data always serializes to the same bytes (comparisons, prompt caching). */
export function stableStringify(value: unknown, space?: number): string {
  return JSON.stringify(sortKeys(value), null, space);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}
