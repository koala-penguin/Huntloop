import { describe, expect, it } from "vitest";
import { allowedHostList, configuredHosts, guardRequest, isAllowedHost, type GuardEnv } from "@/shared/request-guard";

// A tailnet-style stand-in; the owner's real address never goes in tracked files.
const env: GuardEnv = { origin: "http://100.64.0.1:3000" };
const withTest: GuardEnv = { ...env, allowedHosts: "huntloop.test:3210" };

const req = (method: string, pathname: string, headers: Record<string, string>) => ({ method, pathname, headers: new Headers(headers) });
const GOOD = "127.0.0.1:3917";

describe("Host allowlist", () => {
  it.each([
    ["127.0.0.1:3917", true],
    ["localhost:3000", true],
    ["LOCALHOST:3000", true],
    ["localhost", true],
    ["[::1]:3000", true],
    ["100.64.0.1:3000", true],
    ["100.64.0.1:3001", false],
    ["evil.example:3000", false],
    ["huntloop.test:3210", false],
  ])("%s → %s", (host, allowed) => {
    expect(isAllowedHost(host, env)).toBe(allowed);
  });

  it.each([
    "localhost.evil.example",
    "localhost.evil.example:3000",
    "127.0.0.1.nip.io:3000",
    "localhost.:3000",
    "100.64.0.1.:3000",
    "evil.example@127.0.0.1",
    "127.0.0.1:3000, evil.example",
    "127.0.0.1:3000 evil.example",
    "127.0.0.1/evil",
    "127.0.0.1#x",
    "[::ffff:7f00:1]:3000",
    "0.0.0.0:3000",
    "127.0.0.2:3000",
    "",
    "127.0.0.1:123456",
  ])("rejects hostile or non-loopback %j", (host) => {
    expect(isAllowedHost(host, env)).toBe(false);
    expect(guardRequest(req("GET", "/", { host }), env)).toEqual({ status: 421, error: "host_not_allowed" });
  });

  it("refuses a missing Host and never trusts x-forwarded-host", () => {
    expect(guardRequest(req("GET", "/", {}), env)?.status).toBe(421);
    expect(guardRequest(req("GET", "/", { host: "evil.example", "x-forwarded-host": "100.64.0.1:3000" }), env)?.status).toBe(421);
  });

  it("allows configured hosts: with a port exactly, without one on any port", () => {
    expect(isAllowedHost("huntloop.test:3210", withTest)).toBe(true);
    expect(isAllowedHost("huntloop.test:9", withTest)).toBe(false);
    const portless = { allowedHosts: "my-mac.example.ts.net" };
    expect(isAllowedHost("my-mac.example.ts.net:3000", portless)).toBe(true);
    expect(isAllowedHost("my-mac.example.ts.net", portless)).toBe(true);
    expect(isAllowedHost("other.example.ts.net:3000", portless)).toBe(false);
  });

  it("never throws on bad configuration and skips malformed entries", () => {
    const bad = { origin: "not a url", allowedHosts: " , huntloop.test:3210 , evil@x, ," };
    expect(() => guardRequest(req("GET", "/", { host: GOOD }), bad)).not.toThrow();
    expect(guardRequest(req("GET", "/", { host: GOOD }), bad)).toBeNull();
    expect(configuredHosts(bad).hosts.map((h) => h.host)).toEqual(["huntloop.test:3210"]);
    expect(configuredHosts(bad).skipped).toEqual(["not a url", "evil@x"]);
    expect(configuredHosts({ allowedHosts: " , huntloop.test:3210 ," }).hosts).toHaveLength(1);
    expect(() => guardRequest(req("GET", "/", { host: GOOD }), { origin: "::bad" })).not.toThrow();
    expect(allowedHostList(withTest)).toEqual(["localhost", "127.0.0.1", "[::1]", "100.64.0.1:3000", "huntloop.test:3210"]);
  });
});

describe("cross-site block", () => {
  const post = (headers: Record<string, string>, method = "POST", pathname = "/settings") => guardRequest(req(method, pathname, { host: GOOD, ...headers }), env);

  it.each([
    [{ "sec-fetch-site": "same-origin" }, null],
    [{ "sec-fetch-site": "none" }, null],
    [{ "sec-fetch-site": "cross-site" }, 403],
    [{ "sec-fetch-site": "same-site" }, 403],
    [{}, null], // the CLI / curl: neither header
    [{ origin: "http://100.64.0.1:3000" }, null],
    [{ origin: `http://${GOOD}` }, null],
    [{ origin: "http://evil.example" }, 403],
    [{ origin: "null" }, 403],
    [{ origin: "not a url" }, 403],
    // Another local port isn't this app, even though Host checks allow any loopback port.
    [{ origin: "http://localhost:5173" }, 403],
  ])("POST %o → %s", (headers, status) => {
    expect(post(headers)?.status ?? null).toBe(status);
  });

  it("checks every method but GET/HEAD/OPTIONS, in any case", () => {
    for (const method of ["post", "PUT", "PATCH", "DELETE", "PROPFIND"]) expect(post({ "sec-fetch-site": "cross-site" }, method)?.status).toBe(403);
    for (const method of ["GET", "head", "OPTIONS"]) expect(post({ "sec-fetch-site": "cross-site" }, method)).toBeNull();
  });

  it("leaves the token-protected MCP route to its own check (Host still applies)", () => {
    expect(post({ "sec-fetch-site": "cross-site" }, "POST", "/api/claude-code/mcp")).toBeNull();
    expect(guardRequest(req("POST", "/api/claude-code/mcp", { host: "evil.example:3000" }), env)?.status).toBe(421);
  });
});

describe("JSON-only routes", () => {
  const json = (pathname: string, contentType: string, method = "POST") => guardRequest(req(method, pathname, { host: GOOD, "sec-fetch-site": "same-origin", "content-type": contentType }), env);
  it("refuses non-JSON bodies on the chat and translate routes", () => {
    expect(json("/api/coach/chat", "text/plain")).toEqual({ status: 400, error: "invalid" });
    expect(json("/api/coach/chat/", "text/plain")?.status).toBe(400);
    expect(json("/api/coach/chat", "application/json; charset=utf-8")).toBeNull();
    expect(json("/api/jobs/12/chat", "text/plain; x=application/json")?.status).toBe(400);
    expect(json("/api/jobs/12/chat", "application/json")).toBeNull();
    expect(json("/api/jobs/12/translate", "multipart/form-data; boundary=x")?.status).toBe(400);
  });
  it("leaves other routes to their own checks", () => {
    expect(json("/api/jobs", "multipart/form-data; boundary=x")).toBeNull();
    expect(json("/api/jobs", "text/plain", "DELETE")).toBeNull();
  });
});
