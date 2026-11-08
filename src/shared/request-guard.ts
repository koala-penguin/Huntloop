/**
 * Request checks run by `src/proxy.ts` before any page, route or Server Function:
 *  1. Host allowlist (DNS rebinding): loopback names, the host of HUNTLOOP_ORIGIN, and
 *     HUNTLOOP_ALLOWED_HOSTS entries. Exact matches only; nothing here may throw.
 *  2. Cross-site block for state-changing requests (CSRF): Sec-Fetch-Site, else Origin.
 *  3. JSON-only bodies for the chat and translate routes.
 * Pure and isomorphic so it can be unit-tested without a server.
 */

export interface GuardEnv {
  origin?: string | null;
  allowedHosts?: string | null;
}

export const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** A whole Host value: a bracketed IPv6 literal or a plain name/IPv4, and an optional port. */
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i;

/** POST bodies these routes accept are JSON only (text/plain is a type a cross-site form may send). */
export const JSON_ONLY_POST_PATHS: RegExp[] = [/^\/api\/coach\/chat\/?$/, /^\/api\/jobs\/\d+\/chat\/?$/, /^\/api\/jobs\/\d+\/translate\/?$/];

/**
 * Exempt from the cross-site rule only (the Host rule still applies): the Claude Code CLI's tool
 * endpoint, which needs a fresh per-run bearer token, and whose request headers we don't control.
 */
export const CROSS_SITE_EXEMPT_PATHS: RegExp[] = [/^\/api\/claude-code\/mcp\/?$/];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type GuardVerdict = { status: 421 | 403 | 400; error: "host_not_allowed" | "cross_site" | "invalid" } | null;

/** True only when the media type itself is application/json (parameters such as charset allowed). */
export function isJsonContentType(header: string | null): boolean {
  return header?.split(";")[0].trim().toLowerCase() === "application/json";
}

interface ParsedHost {
  /** Lower-cased `hostname[:port]`. */
  host: string;
  hostname: string;
  port: string | null;
}

/** Parses a Host header value; null for anything that isn't exactly `hostname[:port]`. */
export function parseHost(value: string | null | undefined): ParsedHost | null {
  if (typeof value !== "string" || !HOST_PATTERN.test(value)) return null;
  const host = value.toLowerCase();
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    const rest = host.slice(end + 1);
    return { host, hostname: host.slice(0, end + 1), port: rest ? rest.slice(1) : null };
  }
  const colon = host.lastIndexOf(":");
  return colon >= 0 ? { host, hostname: host.slice(0, colon), port: host.slice(colon + 1) } : { host, hostname: host, port: null };
}

/** The configured hosts (HUNTLOOP_ORIGIN's host, then HUNTLOOP_ALLOWED_HOSTS), and entries skipped as malformed. */
export function configuredHosts(env: GuardEnv): { hosts: ParsedHost[]; skipped: string[] } {
  const hosts: ParsedHost[] = [];
  const skipped: string[] = [];
  if (env.origin) {
    try {
      const parsed = parseHost(new URL(env.origin).host);
      if (parsed) hosts.push(parsed);
      else skipped.push(env.origin);
    } catch {
      skipped.push(env.origin);
    }
  }
  for (const raw of (env.allowedHosts ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const parsed = parseHost(entry);
    if (parsed) hosts.push(parsed);
    else skipped.push(entry);
  }
  return { hosts, skipped };
}

/** For the boot log: loopback names plus every configured host. */
export function allowedHostList(env: GuardEnv): string[] {
  return ["localhost", "127.0.0.1", "[::1]", ...configuredHosts(env).hosts.map((h) => (h.port ? h.host : `${h.host}:*`))];
}

/** An entry with a port matches exactly; one without a port matches that hostname on any port. */
function matchesConfigured(host: ParsedHost, env: GuardEnv): boolean {
  return configuredHosts(env).hosts.some((entry) => (entry.port ? entry.host === host.host : entry.hostname === host.hostname));
}

export function isAllowedHost(host: string | null, env: GuardEnv): boolean {
  const parsed = parseHost(host);
  if (!parsed) return false;
  return LOOPBACK_HOSTNAMES.has(parsed.hostname) || matchesConfigured(parsed, env);
}

/** Without Sec-Fetch-Site: an Origin must name this very host or a configured one (not any loopback port). */
function originAllowed(origin: string, requestHost: ParsedHost, env: GuardEnv): boolean {
  if (origin === "null") return false;
  let parsed: ParsedHost | null;
  try {
    parsed = parseHost(new URL(origin).host);
  } catch {
    return false;
  }
  if (!parsed) return false;
  return parsed.host === requestHost.host || matchesConfigured(parsed, env);
}

export function guardRequest(input: { method: string; pathname: string; headers: Headers }, env: GuardEnv): GuardVerdict {
  // 1. Host (only the Host header; x-forwarded-host is not trusted).
  const host = parseHost(input.headers.get("host"));
  if (!host || !isAllowedHost(host.host, env)) return { status: 421, error: "host_not_allowed" };

  const method = input.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return null;

  // 2. Cross-site.
  if (!CROSS_SITE_EXEMPT_PATHS.some((re) => re.test(input.pathname))) {
    const site = input.headers.get("sec-fetch-site");
    if (site !== null) {
      const value = site.trim().toLowerCase();
      if (value !== "same-origin" && value !== "none") return { status: 403, error: "cross_site" };
    } else {
      const origin = input.headers.get("origin");
      // Neither header: not a browser (the CLI, curl). Browsers send Origin on every POST.
      if (origin !== null && !originAllowed(origin, host, env)) return { status: 403, error: "cross_site" };
    }
  }

  // 3. JSON-only routes.
  if (method === "POST" && JSON_ONLY_POST_PATHS.some((re) => re.test(input.pathname)) && !isJsonContentType(input.headers.get("content-type"))) {
    return { status: 400, error: "invalid" };
  }
  return null;
}
