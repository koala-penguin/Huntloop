import dns from "node:dns/promises";
import net from "node:net";

/**
 * Server-side fetch for user-supplied URLs. Blocks private, loopback and link-local addresses
 * (re-checked on every redirect), caps redirects, time and size. Huntloop runs on the user's
 * machine, so this mainly stops a pasted link from reaching the local network.
 */

export class FetchBlockedError extends Error {
  constructor(public readonly reason: "invalid_url" | "private_address" | "too_many_redirects" | "too_large" | "http_error" | "timeout", message?: string) {
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

async function assertPublic(url: URL, resolve: Resolver): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchBlockedError("invalid_url");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new FetchBlockedError("private_address");
  }
  const addresses = net.isIP(host) ? [host] : await resolve(host);
  if (!addresses.length || addresses.some(isPrivateAddress)) throw new FetchBlockedError("private_address");
}

export interface SafeFetchOptions {
  fetchImpl?: typeof fetch;
  resolve?: Resolver;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
}

export interface SafeFetchResult {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve = options.resolve ?? defaultResolver;
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchBlockedError("invalid_url");
  }

  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    await assertPublic(url, resolve);
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
    if (!res.ok) throw new FetchBlockedError("http_error", `HTTP ${res.status}`);

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
