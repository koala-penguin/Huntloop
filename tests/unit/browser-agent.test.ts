import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { checkToolCall, hostAllowList, parseSnapshot, type GuardState } from "@/server/ai/browser-agent/guard";
import { runBrowserAgent } from "@/server/ai/browser-agent/agent";
import { closeBrowser } from "@/server/browser/service";
import { getFakeGenerator, registerFakeGenerator, type FakeGenerator } from "@/server/ai/fake/transport";
import "@/server/ai/fake/generators/browser-agent";
import { usageLog } from "@/server/db/schema";
import { filtersFromPreferences } from "@/shared/schemas/search";
import { defaultPreferences } from "@/shared/schemas/preferences";
import { saveSourceSettings } from "@/server/repo/settings";
import { saveProfileVersion, savePreferences } from "@/server/repo/profile";
import { createJob, getJob, updateJob, upsertCompany } from "@/server/repo/jobs";
import { employerUrlFrom, runFindEmployerPosting } from "@/server/tasks/handlers/find-employer-posting";
import type { TaskContext } from "@/server/tasks/runner";
import { defaultSourceSettings } from "@/shared/source-settings";
import { testDb } from "../helpers/db";
import { CV_TEXT, profile, right } from "../helpers/scoring";
import { startFixtureSites } from "../fixtures/browser/sites.mjs";

const SNAPSHOT = `## Latest page snapshot
uid=1_0 RootWebArea "Frontend Engineer - Example" url="https://jobs.example.gov.au/job/501"
  uid=1_1 main
    uid=1_2 link "Frontend Engineer" url="https://jobs.example.gov.au/job/501"
    uid=1_3 button "Apply now"
    uid=1_4 link "More jobs" url="https://www.linkedin.com/jobs"
    uid=1_5 searchbox "Search jobs"
    uid=1_6 textbox "Email address"
    uid=1_7 textbox "Keywords"
    uid=1_8 link "Next page" url="https://jobs.example.gov.au/search?page=2"
    uid=1_9 button "지원하기"`;

function guard(): GuardState {
  return { snapshots: new Map([[1, parseSnapshot(SNAPSHOT)]]), isAllowedHost: hostAllowList(["example.gov.au"]) };
}

describe("browsing agent guard", () => {
  it("parses snapshots into elements", () => {
    const els = parseSnapshot(SNAPSHOT);
    expect(els.get("1_2")).toEqual({ role: "link", name: "Frontend Engineer", url: "https://jobs.example.gov.au/job/501" });
    expect(els.get("1_3")).toEqual({ role: "button", name: "Apply now", url: null });
  });

  it("allows browsing and searching on allowed sites", () => {
    const g = guard();
    expect(checkToolCall("click", { pageId: 1, uid: "1_2" }, g).ok).toBe(true);
    expect(checkToolCall("click", { pageId: 1, uid: "1_8" }, g).ok).toBe(true);
    expect(checkToolCall("fill", { pageId: 1, uid: "1_5", value: "frontend engineer" }, g).ok).toBe(true);
    expect(checkToolCall("fill", { pageId: 1, uid: "1_7", value: "React" }, g).ok).toBe(true);
    expect(checkToolCall("press_key", { pageId: 1, key: "Enter" }, g).ok).toBe(true);
    expect(checkToolCall("navigate_page", { pageId: 1, type: "url", url: "https://www.jobs.example.gov.au/search" }, g).ok).toBe(true);
    expect(checkToolCall("navigate_page", { pageId: 1, type: "back" }, g).ok).toBe(true);
  });

  it("refuses acting on the user's behalf, leaving the allowed sites, and typing personal details", () => {
    const g = guard();
    const refused = (name: string, input: Record<string, unknown>) => {
      const d = checkToolCall(name, input, g);
      return d.ok ? null : d.reason;
    };
    expect(refused("click", { pageId: 1, uid: "1_3" })).toMatch(/act on the user's behalf/);
    expect(refused("click", { pageId: 1, uid: "1_9" })).toMatch(/act on the user's behalf/);
    expect(refused("click", { pageId: 1, uid: "1_4" })).toMatch(/linkedin\.com isn't one of the sites/);
    expect(refused("click", { pageId: 1, uid: "9_9" })).toMatch(/isn't in the latest snapshot/);
    expect(refused("click", { pageId: 2, uid: "1_2" })).toMatch(/Take a snapshot/);
    expect(refused("fill", { pageId: 1, uid: "1_6", value: "frontend" })).toMatch(/account, contact/);
    expect(refused("fill", { pageId: 1, uid: "1_5", value: "me@example.com" })).toMatch(/no contact details/);
    expect(refused("press_key", { pageId: 1, key: "Control+A" })).toMatch(/Only Enter/);
    expect(refused("new_page", { url: "https://www.seek.com.au/jobs" })).toMatch(/seek\.com\.au isn't one/);
    expect(refused("navigate_page", { pageId: 1, type: "url", url: "javascript:alert(1)" })).toMatch(/http/);
    expect(refused("upload_file", { pageId: 1, uid: "1_3", filePaths: ["/etc/passwd"] })).toMatch(/isn't available/);
    expect(refused("evaluate_script", {})).toMatch(/isn't available/);
  });

  it("turns a company domain into the employer's start page", () => {
    expect(employerUrlFrom("tidal.example")).toBe("https://tidal.example");
    expect(employerUrlFrom("http://127.0.0.1:3299/employer/")).toBe("http://127.0.0.1:3299/employer/");
    expect(employerUrlFrom("not a domain")).toBeNull();
    expect(employerUrlFrom(null)).toBeNull();
  });

  it("strips options that write files or open hidden contexts", () => {
    const g = guard();
    const snap = checkToolCall("take_snapshot", { pageId: 1, filePath: "/tmp/x", verbose: true }, g);
    expect(snap).toEqual({ ok: true, input: { pageId: 1 } });
    const page = checkToolCall("new_page", { url: "https://jobs.example.gov.au", isolatedContext: "x", background: true }, g);
    expect(page.ok && page.input).toEqual({ url: "https://jobs.example.gov.au", timeout: 30_000 });
  });
});

const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const saved = { ...process.env };
let sites: { url: string; close: () => Promise<void> };
const demoAgent = getFakeGenerator("browserAgent")!;
let override: FakeGenerator | null = null;
registerFakeGenerator("browserAgent", (req) => (override ?? demoAgent)(req));

describe.skipIf(!fs.existsSync(CHROMIUM))("browsing agent (Chrome DevTools MCP, headless Chromium, local pages)", () => {
  beforeAll(async () => {
    sites = await startFixtureSites();
    Object.assign(process.env, {
      HUNTLOOP_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-agent-")),
      HUNTLOOP_BROWSER_PATH: CHROMIUM,
      HUNTLOOP_BROWSER_HEADLESS: "1",
      HUNTLOOP_BROWSER_PACING_MS: "0",
    });
  });
  afterAll(async () => {
    await closeBrowser();
    await sites.close();
    for (const key of ["HUNTLOOP_DATA_DIR", "HUNTLOOP_BROWSER_PATH", "HUNTLOOP_BROWSER_HEADLESS", "HUNTLOOP_BROWSER_PACING_MS"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  afterEach(() => {
    override = null;
  });

  const filters = filtersFromPreferences({ ...defaultPreferences(), targetTitles: ["Frontend Engineer"] });

  it("searches a site without an adapter and reads the jobs it opened", async () => {
    const { db, userId } = testDb();
    const notes: string[] = [];
    const result = await runBrowserAgent(
      { db, userId },
      { kind: "search", site: { name: "Example Public Jobs", url: `${sites.url}/board/search?q=frontend` }, filters, maxJobs: 5, source: "browser_agent" },
      { onProgress: (n) => notes.push(n) },
    );
    expect(result.leads.map((l) => l.url)).toEqual([`${sites.url}/board/job/501`, `${sites.url}/board/job/502`]);
    expect(result.leads[0]).toMatchObject({ source: "browser_agent", full: true });
    expect(result.leads[0].text).toContain("Australian citizenship is required");
    expect(result.dropped).toBe(1); // reported but never opened
    expect(notes).toContain("Reading the page");
    expect(db.select().from(usageLog).all().every((u) => u.task === "browserAgent")).toBe(true);
  }, 60_000);

  it("finds a job on the employer's own careers pages", async () => {
    const { db, userId } = testDb();
    const result = await runBrowserAgent(
      { db, userId },
      { kind: "find_on_employer_site", job: { title: "Frontend Engineer", company: "Tidal Labs", location: "Sydney" }, employerUrl: `${sites.url}/employer/` },
    );
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0].url).toBe(`${sites.url}/employer/careers/frontend-engineer`);
    expect(result.leads[0].text).toContain("Experience with WebGL is a plus");
  }, 60_000);

  it("refuses unsafe actions and tells Claude why", async () => {
    const { db, userId } = testDb();
    let step = 0;
    let pageId = 1;
    const replies: string[] = [];
    override = (req) => {
      const last = req.body.messages.at(-1)!;
      if (Array.isArray(last.content)) for (const b of last.content as Array<{ type: string; content?: unknown }>) if (b.type === "tool_result") replies.push(String(b.content));
      const tool = (name: string, input: Record<string, unknown>) => ({ content: [{ type: "tool_use", id: `toolu_t${step}`, name, input }] });
      step++;
      if (step === 1) return tool("new_page", { url: `${sites.url}/board/job/501` });
      if (step === 2) {
        pageId = Number(/^(\d+):.*\[selected\]/m.exec(replies.at(-1) ?? "")?.[1] ?? 1);
        return tool("take_snapshot", { pageId });
      }
      if (step === 3) {
        const apply = /uid=(\S+) button "Apply now"/.exec(replies.at(-1) ?? "")?.[1] ?? "x";
        return tool("click", { pageId, uid: apply });
      }
      if (step === 4) return tool("navigate_page", { pageId, type: "url", url: "https://www.linkedin.com/jobs" });
      return { content: [{ type: "tool_use", id: "toolu_report", name: "report_job_leads", input: { leads: [] } }] };
    };
    const result = await runBrowserAgent({ db, userId }, { kind: "search", site: { name: "Example", url: `${sites.url}/board/search` }, filters, maxJobs: 2, source: "browser_agent" });
    expect(result.refused).toBe(2);
    expect(replies.some((r) => /Refused: "Apply now" would act on the user's behalf/.test(r))).toBe(true);
    expect(replies.some((r) => /Refused: www\.linkedin\.com isn't one of the sites/.test(r))).toBe(true);
  }, 60_000);

  it("the 'find on the employer's site' task swaps in the employer's full posting", async () => {
    const { db, userId } = testDb();
    saveProfileVersion(db, userId, { cvText: CV_TEXT, data: profile({}, [right("AU", "citizen", "au_citizen")]) });
    savePreferences(db, userId, defaultPreferences());
    const companyId = upsertCompany(db, userId, { name: "Tidal Labs", domain: `${sites.url}/employer/` });
    const job = createJob(db, userId, { source: "linkedin", sourceUrl: "https://www.linkedin.com/jobs/view/3900000001", title: "Frontend Engineer", companyName: "Tidal Labs" });
    updateJob(db, job.id, { companyId });
    const ctx = { db, userId, payload: { jobId: job.id }, signal: new AbortController().signal, progress: () => {} } as unknown as TaskContext;

    await expect(runFindEmployerPosting(ctx)).rejects.toThrow("agent_disabled");

    const settings = defaultSourceSettings();
    settings.agent.enabled = true;
    saveSourceSettings(db, userId, settings);
    expect(await runFindEmployerPosting(ctx)).toEqual({ found: true, url: `${sites.url}/employer/careers/frontend-engineer` });
    const updated = getJob(db, userId, job.id)!;
    expect(updated).toMatchObject({ applyUrl: `${sites.url}/employer/careers/frontend-engineer`, descriptionIsFull: true, intakeStatus: "ready" });
    expect(updated.rawText).toContain("Experience with WebGL is a plus");
  }, 60_000);
});
