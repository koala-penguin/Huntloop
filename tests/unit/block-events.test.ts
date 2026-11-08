import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordBlockEvent } from "@/server/browser/block-events";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const fakePage = (overrides: { screenshot?: () => Promise<Buffer> } = {}) => ({
  screenshot: async ({ path: file }: { path?: string } = {}) => {
    if (overrides.screenshot) return overrides.screenshot();
    fs.writeFileSync(file!, PNG_BYTES);
    return PNG_BYTES;
  },
  title: async () => "Just a moment...",
  url: () => "https://www.seek.com.au/job/1",
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-blocks-"));
const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 1, minute, 0));
const files = (dir: string, ext: string) => fs.readdirSync(dir).filter((f) => f.endsWith(ext) && f !== "counts.json");

afterEach(() => vi.restoreAllMocks());

describe("CAPTCHA / sign-in events", () => {
  it("saves a screenshot and a record per event, and counts them per site and kind", async () => {
    const dir = tmp();
    await recordBlockEvent(fakePage(), { site: "seek", kind: "captcha", waiting: true }, { dir, webhook: null, now: at(1) });
    await recordBlockEvent(fakePage(), { site: "seek", kind: "captcha", waiting: true }, { dir, webhook: null, now: at(2) });
    const event = await recordBlockEvent(fakePage(), { site: "linkedin", kind: "login", waiting: false }, { dir, webhook: null, now: at(3) });
    expect(files(dir, ".png")).toHaveLength(3);
    expect(files(dir, ".json")).toHaveLength(3);
    expect(event).toMatchObject({ site: "linkedin", kind: "login", url: "https://www.seek.com.au/job/1", title: "Just a moment..." });
    expect(event.screenshot).toMatch(/-linkedin-login\.png$/);
    const counts = JSON.parse(fs.readFileSync(path.join(dir, "counts.json"), "utf8"));
    expect(counts).toMatchObject({ seek: { total: 2, byKind: { captcha: 2 } }, linkedin: { total: 1, byKind: { login: 1 } } });
    expect(counts.seek.last).toBe(at(2).toISOString());
  });

  it("bounds the screenshot so the pause prompt isn't held up", async () => {
    const seen: Array<{ timeout?: number }> = [];
    const page = { ...fakePage(), screenshot: async (opts: { path?: string; timeout?: number } = {}) => (seen.push(opts), fs.writeFileSync(opts.path!, PNG_BYTES), PNG_BYTES) };
    await recordBlockEvent(page, { site: "seek", kind: "captcha", waiting: false }, { dir: tmp(), webhook: null, now: at(1) });
    expect(seen[0].timeout).toBe(5_000);
  });

  it("sends nothing without a webhook, or when nobody is waiting to act", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    await recordBlockEvent(fakePage(), { site: "seek", kind: "captcha", waiting: true }, { dir: tmp(), webhook: null, fetchImpl, now: at(1) });
    await recordBlockEvent(fakePage(), { site: "seek", kind: "captcha", waiting: false }, { dir: tmp(), webhook: "https://discord.example/api/webhooks/1/x", fetchImpl, now: at(1) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores a webhook that isn't a URL, without printing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const dir = tmp();
    await recordBlockEvent(fakePage(), { site: "seek", kind: "captcha", waiting: true }, { dir, webhook: "not a url", fetchImpl, now: at(1) });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(files(dir, ".png")).toHaveLength(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("not a url");
  });

  it("posts one Discord message with the screenshot attached", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await recordBlockEvent(fakePage(), { site: "seek", kind: "captcha", waiting: true }, { dir: tmp(), webhook: "https://discord.example/api/webhooks/1/x", fetchImpl, now: at(1) });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://discord.example/api/webhooks/1/x");
    expect(calls[0].init.method).toBe("POST");
    const body = calls[0].init.body as FormData;
    const payload = JSON.parse(String(body.get("payload_json")));
    expect(payload.content).toContain("seek");
    expect(payload.content).toContain("captcha");
    expect(payload.content).toContain("https://www.seek.com.au/job/1");
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    const file = body.get("files[0]") as File;
    expect(file.name).toMatch(/\.png$/);
    expect(file.size).toBe(PNG_BYTES.length);
  });

  it("never fails the run: a failed webhook or screenshot still leaves a record", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dir = tmp();
    const failing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(recordBlockEvent(fakePage(), { site: "seek", kind: "captcha", waiting: true }, { dir, webhook: "https://discord.example/api/webhooks/1/x", fetchImpl: failing, now: at(1) })).resolves.toBeTruthy();
    expect(files(dir, ".png")).toHaveLength(1);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("discord.example");

    const calls: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const noShot = fakePage({ screenshot: async () => Promise.reject(new Error("page closed")) });
    const event = await recordBlockEvent(noShot, { site: "seek", kind: "captcha", waiting: true }, { dir: tmp(), webhook: "https://discord.example/api/webhooks/1/x", fetchImpl, now: at(2) });
    expect(event.screenshot).toBeNull();
    expect(calls).toHaveLength(1);
    expect((calls[0].body as FormData).get("files[0]")).toBeNull();
  });
});
