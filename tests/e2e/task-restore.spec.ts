import { expect, holdScripts, test } from "./fixtures";
import type { Locator, Page, Request } from "@playwright/test";

// A background task started from a job page must survive the user leaving and coming back. Coming
// back must show the task still running, or its finished result — never the button that starts it
// as if nothing had happened. Browser back can restore the page from the client cache (rendered
// before the task) or, in Safari, from the back/forward cache.
// Demo replies are held back (HUNTLOOP_FAKE_DELAY in playwright.config.ts) for employers named
// "Slowpoke …" (research, browsing) and jobs at "Sloth …" (assessing), so they stay running for a while.

function posting(company: string) {
  return `Platform Engineer — ${company}, Auckland\nFull time · Hybrid\n\nWhat you'll do\nRun the cloud platform our product teams ship on.\n\nRequirements\n• 4+ years of platform engineering experience\n• Experience with Kubernetes and Terraform\n• Experience with Go is a plus`;
}

/** Requests each page has in flight (counted from beforeEach). */
const inFlight = new WeakMap<Page, Set<Request>>();

/**
 * Waits until the page has had no request in flight for a moment. Playwright's "networkidle" can't
 * do this: it fires once per document, so later fetches (a refresh after starting a task) aren't
 * waited for.
 */
async function settle(page: Page) {
  const pending = inFlight.get(page)!;
  let quietSince = Date.now();
  await expect
    .poll(
      () => {
        if (pending.size) quietSince = Date.now();
        return Date.now() - quietSince;
      },
      { timeout: 15_000, intervals: [50] },
    )
    .toBeGreaterThanOrEqual(300);
}

/**
 * A full page load. Waits for the current page's fetches first: WebKit cuts them off when a document
 * navigation starts, reports cut-off prefetches as uncaught errors ("… due to access control checks"),
 * and Next.js answers a cut-off refresh by loading that page again, which interrupts this navigation.
 */
async function go(page: Page, url: string) {
  await settle(page);
  await page.goto(url);
}

let counter = 0;
const unique = (name: string) => `${name} ${test.info().project.name} ${Date.now().toString(36)}${counter++}`;

async function addJob(page: Page, company: string): Promise<string> {
  await go(page, "/jobs");
  await page.getByRole("textbox", { name: "Job link or posting text" }).fill(posting(company));
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 40_000 });
  return new URL(page.url()).pathname;
}

// On a slow phone the box shows before the page's scripts run; a posting pasted then must still be added.
test("a posting pasted before the page finished loading can be added", async ({ page }) => {
  const release = await holdScripts(page);
  await page.goto("/jobs", { waitUntil: "domcontentloaded" });
  await page.getByRole("textbox", { name: "Job link or posting text" }).fill(posting(unique("Kereru")));
  release();
  await expect(page.getByRole("button", { name: "Add job" })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
});

/** Remembers the background task the page polls, so a test can wait for it to finish while away. */
function watchTasks(page: Page) {
  let last: number | null = null;
  page.on("request", (request) => {
    const m = /\/api\/tasks\/(\d+)$/.exec(new URL(request.url()).pathname);
    if (m) last = Number(m[1]);
  });
  return {
    async waitUntilFinished() {
      expect(last, "the page polled a task").not.toBeNull();
      await expect
        .poll(async () => ((await (await page.request.get(`/api/tasks/${last}`)).json()) as { status: string }).status, { timeout: 40_000 })
        .toMatch(/succeeded|failed|cancelled/);
    },
    /** Stops the task (as Huntloop's task controls do), then waits until it has. */
    async cancel() {
      expect(last, "the page polled a task").not.toBeNull();
      const res = await page.request.delete(`/api/tasks/${last}`, { headers: { origin: new URL(page.url()).origin } });
      expect(res.ok()).toBe(true);
      await this.waitUntilFinished();
    },
  };
}

type Way = "link, then back" | "back, then forward" | "another page, then back";

/** Leave the job page and come back the way people do on a phone. */
async function leaveAndReturn(page: Page, path: string, way: Way, whileAway?: () => Promise<void>) {
  if (way === "link, then back") {
    await page.getByRole("link", { name: "All jobs" }).click();
    await expect(page).toHaveURL(/\/jobs$/);
    await whileAway?.();
    await page.goBack();
  } else if (way === "back, then forward") {
    await page.goBack();
    await expect(page).toHaveURL(/\/jobs$/);
    await whileAway?.();
    await page.goForward();
  } else {
    // A full page load elsewhere: coming back is a new document, or Safari's back/forward cache.
    await go(page, "/pipeline");
    await whileAway?.();
    // Back is a document navigation too: let this page's fetches finish first (see go()).
    await settle(page);
    await page.goBack();
  }
  await expect(page).toHaveURL(new RegExp(`${path}(\\?.*)?$`));
  const restored = await page.evaluate(() => (window as unknown as { __restored?: number }).__restored ?? 0);
  const note = restored ? "restored from the back/forward cache" : "not restored from the back/forward cache";
  test.info().annotations.push({ type: "bfcache", description: note });
  console.log(`[${test.info().project.name}] ${test.info().title}: ${note}`);
}

test.beforeEach(async ({ page }) => {
  const pending = new Set<Request>();
  inFlight.set(page, pending);
  page.on("request", (request) => pending.add(request));
  page.on("requestfinished", (request) => pending.delete(request));
  page.on("requestfailed", (request) => pending.delete(request));
  await page.addInitScript(() => {
    window.addEventListener("pageshow", (event) => {
      if (event.persisted) {
        const w = window as unknown as { __restored?: number };
        w.__restored = (w.__restored ?? 0) + 1;
      }
    });
  });
});

/** Coming back: still running (and not offering to start), then the result; or the result straight away. */
async function expectFollowed(running: Locator, result: Locator, start: Locator | null) {
  await expect(running.or(result).first()).toBeVisible({ timeout: 10_000 });
  if (start && (await running.isVisible())) await expect(start).toHaveCount(0);
  await expect(result).toBeVisible({ timeout: 40_000 });
  if (start) await expect(start).toHaveCount(0);
}

// ---- Employer research (Employer tab) ----

const research = (page: Page) => ({
  start: page.getByRole("button", { name: "Research this employer" }),
  running: page.getByRole("status").filter({ hasText: "Researching the employer…" }),
  result: page.getByRole("heading", { name: "What this means for you" }),
  open: () => page.getByRole("tab", { name: "Employer" }).click(),
});

for (const way of ["link, then back", "back, then forward", "another page, then back"] as const) {
  for (const when of ["running", "finished"] as const) {
    test(`employer research: ${way}, ${when}`, async ({ page }) => {
      const tasks = watchTasks(page);
      const path = await addJob(page, unique("Slowpoke Kauri"));
      const r = research(page);
      await r.open();
      await r.start.click();
      await expect(r.running).toBeVisible();
      await leaveAndReturn(page, path, way, when === "finished" ? tasks.waitUntilFinished : undefined);
      await r.open();
      await expectFollowed(r.running, r.result, r.start);
    });
  }
}

test("employer research: switch tabs and back", async ({ page }) => {
  await addJob(page, unique("Slowpoke Totara"));
  const r = research(page);
  await r.open();
  await r.start.click();
  await expect(r.running).toBeVisible();
  await page.getByRole("tab", { name: "Posting" }).click();
  await r.open();
  await expectFollowed(r.running, r.result, r.start);
});

test("employer research started elsewhere shows up when Safari restores the page from its back/forward cache", async ({ page, context }) => {
  const path = await addJob(page, unique("Slowpoke Hoiho"));
  const r = research(page);
  await r.open();
  await expect(r.start).toBeVisible();

  // Meanwhile research starts from another tab (or device) while this page sits in the cache…
  const other = await context.newPage();
  await other.goto(path);
  const o = research(other);
  await o.open();
  await o.start.click();
  await expect(o.running).toBeVisible();
  await other.close();

  // …and the browser brings this page back exactly as it was left (Playwright's WebKit never does
  // this on its own, so the restore's pageshow event is replayed).
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  await expectFollowed(r.running, r.result, r.start);
});

// ---- Find on the employer's site (Posting tab) ----

for (const when of ["running", "finished"] as const) {
  test(`find on the employer's site: link, then back, ${when}`, async ({ page }) => {
    await go(page, "/settings");
    const agent = page.locator('[data-site="agent"]');
    const toggle = agent.getByRole("checkbox", { name: "Use the AI browsing agent" });
    if (!(await toggle.isChecked())) {
      await toggle.click();
      await agent.getByRole("button", { name: "Turn it on" }).click();
      await expect(toggle).toBeChecked();
    }
    const tasks = watchTasks(page);
    const path = await addJob(page, unique("Slowpoke Matai"));
    const open = () => page.getByRole("tab", { name: "Posting" }).click();
    const start = page.getByRole("button", { name: "Find on the employer's site" });
    const running = page.getByRole("status").filter({ hasText: "Looking for the job on the employer's site…" });
    // The result of a search that found nothing (the button stays, to try again).
    const result = page.getByText("The agent couldn't find this job on the employer's site.");
    await open();
    await start.click();
    await expect(running).toBeVisible();
    await leaveAndReturn(page, path, "link, then back", when === "finished" ? tasks.waitUntilFinished : undefined);
    await open();
    // Never just the button: the search is still going, or its result shows (with the button to try again).
    await expect(running.or(result).first()).toBeVisible({ timeout: 10_000 });
    await expect(result).toBeVisible({ timeout: 40_000 });
  });
}

// The page restored by Back predates the search, and refreshes (here: a status change) while the
// search control is still asking the server what it missed. The finished search must still show.
test("find on the employer's site: the page refreshes while coming back", async ({ page }) => {
  await go(page, "/settings");
  const agent = page.locator('[data-site="agent"]');
  const toggle = agent.getByRole("checkbox", { name: "Use the AI browsing agent" });
  if (!(await toggle.isChecked())) {
    await toggle.click();
    await agent.getByRole("button", { name: "Turn it on" }).click();
    await expect(toggle).toBeChecked();
  }
  const tasks = watchTasks(page);
  const path = await addJob(page, unique("Slowpoke Rimu"));
  const open = () => page.getByRole("tab", { name: "Posting" }).click();
  const running = page.getByRole("status").filter({ hasText: "Looking for the job on the employer's site…" });
  const result = page.getByText("The agent couldn't find this job on the employer's site.");
  await open();
  await page.getByRole("button", { name: "Find on the employer's site" }).click();
  await expect(running).toBeVisible();
  await leaveAndReturn(page, path, "link, then back", tasks.waitUntilFinished);

  // Hold the control's question until the page has refreshed.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/jobs\/\d+\/tasks$/, async (route) => {
    await held;
    await route.continue();
  });
  await open();
  await page.getByRole("combobox", { name: "Status" }).selectOption("shortlisted");
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("shortlisted");
  release();
  await expect(running.or(result).first()).toBeVisible({ timeout: 10_000 });
  await expect(result).toBeVisible({ timeout: 40_000 });
});

// ---- Update an out-of-date assessment ----

for (const when of ["running", "finished"] as const) {
  test(`update assessment: link, then back, ${when}`, async ({ page }) => {
    const tasks = watchTasks(page);
    const path = await addJob(page, unique("Sloth Kowhai"));
    // A new confirmed fact makes the assessment out of date.
    await go(page, "/profile");
    await page.getByRole("textbox", { name: "Add a fact" }).fill(unique("Ran a Kubernetes platform migration"));
    await page.getByRole("button", { name: "Add fact" }).click();
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText(/Saved as version \d+/)).toBeVisible();

    await go(page, "/jobs");
    await page.locator(`a[href="${path}"]`).first().click();
    const start = page.getByRole("button", { name: "Update assessment" });
    const notice = page.getByText(/changed since this assessment/);
    await start.click();
    const running = page.getByText(/^(Waiting to start|Comparing with your profile|Working out your Interview Chance)…$/);
    await expect(running).toBeVisible();

    await leaveAndReturn(page, path, "link, then back", when === "finished" ? tasks.waitUntilFinished : undefined);
    // Still assessing, or done: the out-of-date notice and its button are gone either way.
    await expect(start).toHaveCount(0, { timeout: 10_000 });
    await expect(notice).toHaveCount(0, { timeout: 40_000 });
  });
}

// ---- Tasks that stop without a result: why, and the button to try again; never a spinner that never ends ----

const failedError = (page: Page) => page.getByText(/Simulated failure/);
const cancelledError = (page: Page) => page.getByText("This was stopped before it finished.");

/** The error and the button show, nothing runs, and they stay after the page's refresh. */
async function expectStopped(page: Page, error: Locator, button: Locator, running: Locator) {
  await expect(error).toBeVisible({ timeout: 10_000 });
  await expect(button).toBeVisible();
  await expect(running).toHaveCount(0);
  await page.waitForTimeout(2_000);
  await expect(error).toBeVisible();
  await expect(button).toBeVisible();
}

test("employer research that fails while you watch: the error, and Start again", async ({ page }) => {
  await addJob(page, unique("Doomed Kea"));
  const r = research(page);
  await r.open();
  await r.start.click();
  await expect(failedError(page)).toBeVisible({ timeout: 15_000 });
  await expect(r.running).toHaveCount(0);
  await expect(r.start).toBeVisible();
});

for (const end of ["fails", "is cancelled"] as const) {
  test(`employer research that ${end} while away: the error and Start again on return`, async ({ page }) => {
    const tasks = watchTasks(page);
    const path = await addJob(page, unique(end === "fails" ? "Doomed Slowpoke Kea" : "Slowpoke Weka"));
    const r = research(page);
    await r.open();
    await r.start.click();
    await expect(r.running).toBeVisible();
    await leaveAndReturn(page, path, "link, then back", end === "fails" ? tasks.waitUntilFinished : () => tasks.cancel());
    await r.open();
    await expectStopped(page, end === "fails" ? failedError(page) : cancelledError(page), r.start, r.running);
  });
}

test("update assessment cancelled while away: the error and Update again on return", async ({ page }) => {
  const tasks = watchTasks(page);
  const path = await addJob(page, unique("Sloth Tui"));
  await go(page, "/profile");
  await page.getByRole("textbox", { name: "Add a fact" }).fill(unique("Ran a Terraform module library"));
  await page.getByRole("button", { name: "Add fact" }).click();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText(/Saved as version \d+/)).toBeVisible();

  await go(page, "/jobs");
  await page.locator(`a[href="${path}"]`).first().click();
  const start = page.getByRole("button", { name: "Update assessment" });
  const running = page.getByText(/^(Waiting to start|Comparing with your profile|Working out your Interview Chance)…$/);
  await start.click();
  await expect(running).toBeVisible();

  await leaveAndReturn(page, path, "link, then back", () => tasks.cancel());
  await expectStopped(page, cancelledError(page), start, running);
  await expect(page.getByText(/changed since this assessment/)).toBeVisible();
});

test("tailored CV that fails while away: the error and Write again on return", async ({ page }) => {
  const tasks = watchTasks(page);
  const path = await addJob(page, unique("Doomed Slowpoke Kahu"));
  await page.getByRole("button", { name: "Proceed & tailor my CV" }).click();
  await expect(page).toHaveURL(/tab=cv/);
  const running = page.getByRole("status").filter({ hasText: /^(Waiting to start|Planning what to emphasise|Writing your tailored CV|Checking every line against your CV)…$/ });
  await expect(running).toBeVisible();

  await leaveAndReturn(page, path, "link, then back", tasks.waitUntilFinished);
  await page.getByRole("tab", { name: "CV" }).click();
  await expectStopped(page, failedError(page), page.getByRole("button", { name: "Write my tailored CV" }), running);
});
