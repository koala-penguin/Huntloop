import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

const saved = { origin: process.env.HUNTLOOP_ORIGIN, hosts: process.env.HUNTLOOP_ALLOWED_HOSTS };
afterEach(() => {
  process.env.HUNTLOOP_ORIGIN = saved.origin;
  process.env.HUNTLOOP_ALLOWED_HOSTS = saved.hosts;
  if (saved.origin === undefined) delete process.env.HUNTLOOP_ORIGIN;
  if (saved.hosts === undefined) delete process.env.HUNTLOOP_ALLOWED_HOSTS;
  vi.restoreAllMocks();
});

const request = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => new NextRequest(url, init);

describe("proxy", () => {
  it("blocks a cross-site POST", async () => {
    const res = proxy(request("http://127.0.0.1:3917/settings", { method: "POST", headers: { host: "127.0.0.1:3917", "sec-fetch-site": "cross-site" } }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_site" });
  });

  it("answers a foreign Host with 421 and says how to allow it", async () => {
    const res = proxy(request("http://evil.example:3917/profile", { headers: { host: "evil.example:3917" } }));
    expect(res.status).toBe(421);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toContain("HUNTLOOP_ALLOWED_HOSTS");
    expect(body).toContain('"evil.example:3917"');
  });

  it("lets a same-origin POST through, reading the env per request", () => {
    process.env.HUNTLOOP_ORIGIN = "http://100.64.0.1:3000";
    const res = proxy(request("http://100.64.0.1:3000/settings", { method: "POST", headers: { host: "100.64.0.1:3000", "sec-fetch-site": "same-origin" } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
    delete process.env.HUNTLOOP_ORIGIN;
    expect(proxy(request("http://100.64.0.1:3000/", { headers: { host: "100.64.0.1:3000" } })).status).toBe(421);
  });

  it("doesn't throw on a broken HUNTLOOP_ORIGIN; loopback still works", () => {
    process.env.HUNTLOOP_ORIGIN = "::bad";
    process.env.HUNTLOOP_ALLOWED_HOSTS = "@@,";
    const res = proxy(request("http://127.0.0.1:3917/", { headers: { host: "127.0.0.1:3917" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});
