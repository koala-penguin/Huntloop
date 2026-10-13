import dns from "node:dns/promises";
import net from "node:net";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";

/**
 * Server-side fetch for user-supplied URLs. Blocks private, loopback and link-local addresses
 * (re-checked on every redirect), caps redirects, time and size. Huntloop runs on the user's
 * machine, so this mainly stops a pasted link from reaching the local network. When HTTPS_PROXY /
 * HTTP_PROXY is set (corporate networks, sandboxed cloud machines) requests go through the proxy.
 */

export class FetchBlockedError extends Error {
  constructor(
    public readonly reason: "invalid_url" | "private_address" | "restricted" | "too_many_redirects" | "too_large" | "http_error" | "timeout",
    message?: string,
    /** The URL that was refused (for "restricted": a site Huntloop may not read). */
    public readonly url?: string,
    /** For "http_error": the response status. */
    public readonly status?: number,
  ) {
    super(message ?? reason);
    this.name = "FetchBlockedError";
  }
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (net.isIPv6(address)) {
    const v = address.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith("ff");
  }
  return true;
}

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** An outbound proxy is configured (HTTPS_PROXY / HTTP_PROXY; NO_PROXY is honoured per request). */
export function proxyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
}

let proxiedFetch: typeof fetch | null = null;

/** Node's built-in fetch ignores proxy variables; with a proxy configured, requests go through it. */
export function outboundFetch(): typeof fetch {
  if (!proxyConfigured()) return fetch;
  if (!proxiedFetch) {
    const dispatcher = new EnvHttpProxyAgent();
    proxiedFetch = ((input: string | URL, init?: RequestInit) => undiciFetch(input, { ...(init as object), dispatcher } as never)) as unknown as typeof fetch;
  }
  return proxiedFetch;
}

async function assertPublic(url: URL, resolve: Resolver, viaProxy: boolean): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchBlockedError("invalid_url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new FetchBlockedError("private_address");
  }
  let addresses: string[];
  try {
    addresses = net.isIP(host) ? [host] : await resolve(host);
  } catch (error) {
    // Behind a proxy the machine may not resolve outside names itself; the proxy connects instead.
    const code = (error as NodeJS.ErrnoException).code;
    if (viaProxy && (code === "ENOTFOUND" || code === "EAI_AGAIN")) return;
    throw error;
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new FetchBlockedError("private_address");
}

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  /** Checked on the first URL and every redirect target, e.g. the site policy. */
  allow?: (url: URL) => boolean;
  /** Requests go through a proxy (default: when one is configured and no fetchImpl is given). */
  viaProxy?: boolean;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? outboundFetch();
  const viaProxy = options.viaProxy ?? (!options.fetchImpl && proxyConfigured());
  const resolve = options.resolve ?? defaultResolver;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchBlockedError("invalid_url");
  }

  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    if (options.allow && !options.allow(url)) throw new FetchBlockedError("restricted", `Not allowed to read ${url.hostname}`, url.toString());
    await assertPublic(url, resolve, viaProxy);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; Huntloop/0.1; personal job-search assistant)",
          accept: options.accept ?? "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "accept-language": "en-AU,en;q=0.9",
        },
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new FetchBlockedError("timeout");
      throw error;
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) throw new FetchBlockedError("http_error", `HTTP ${res.status}`, url.toString(), res.status);

    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new FetchBlockedError("too_large");
        }
        chunks.push(value);
      }
    }
    const body = new TextDecoder("utf-8").decode(Buffer.concat(chunks));
    return { url: url.toString(), status: res.status, contentType: res.headers.get("content-type") ?? "", body };
  }
  throw new FetchBlockedError("too_many_redirects");
}
