// The proxy (src/proxy.ts) against the real server: Host allowlist, cross-site block, JSON-only
// chat route. Creates no jobs (specs in the "app" project share one database, in file order).
import http from "node:http";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "./fixtures";

function jobCount(): number {
  const db = new Database(path.join(process.env.HUNTLOOP_E2E_DATA_DIR!, "huntloop.db"), { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("select count(*) as n from jobs").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** A GET with a Host header of our choosing (fetch and Playwright's request set their own). */
function getWithHost(baseURL: string, pathname: string, host: string): Promise<{ status: number; body: string }> {
  const url = new URL(pathname, baseURL);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: url.pathname, method: "GET", headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("a cross-site POST is refused before it reaches the route", async ({ request }) => {
  const before = jobCount();
  const res = await request.post("/api/jobs", {
    multipart: { text: "Senior Frontend Engineer at Evil Corp. Requirements: React." },
    headers: { "sec-fetch-site": "cross-site", origin: "http://evil.example" },
  });
  expect(res.status()).toBe(403);
  expect(await res.json()).toEqual({ error: "cross_site" });
  expect(jobCount()).toBe(before);
});

test("the coach chat only takes JSON", async ({ request }) => {
  // A valid body the route would accept as JSON, sent as text/plain (what a cross-site form can do).
  const res = await request.post("/api/coach/chat", { data: JSON.stringify({ text: "hello" }), headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin" } });
  expect(res.status()).toBe(400);
  expect(await res.json()).toEqual({ error: "invalid" });
});

test("a same-origin POST reaches the route", async ({ request }) => {
  const before = jobCount();
  const res = await request.post("/api/jobs", { multipart: { text: "" }, headers: { "sec-fetch-site": "same-origin" } });
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
  expect(await res.text()).not.toContain("cross_site");
  expect(jobCount()).toBe(before);
});

test("pages answer only for allowed hosts", async ({ baseURL }) => {
  const port = new URL(baseURL!).port;
  const evil = await getWithHost(baseURL!, "/profile", `evil.example:${port}`);
  expect(evil.status).toBe(421);
  expect(evil.body).toContain("HUNTLOOP_ALLOWED_HOSTS");
  expect((await getWithHost(baseURL!, "/profile", `localhost:${port}`)).status).toBe(200);
  expect((await getWithHost(baseURL!, "/profile", `huntloop.test:${port}`)).status).toBe(200);
  expect((await getWithHost(baseURL!, "/profile", "huntloop.test:9")).status).toBe(421);
});

test("the MCP route keeps its own token check, also for a cross-site request", async ({ request }) => {
  const token = "a".repeat(64);
  const body = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
  expect((await request.post("/api/claude-code/mcp", { data: body, headers })).status()).toBe(401);
  expect((await request.post("/api/claude-code/mcp", { data: body, headers: { ...headers, "sec-fetch-site": "cross-site" } })).status()).toBe(401);
});
