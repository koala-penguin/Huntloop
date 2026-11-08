// Swipe a search result to the left to delete it (with Undo), on touch screens. Runs on iPhone Safari
// (WebKit) and on a touch Chromium phone (playwright.config.ts). Each test seeds its own search and jobs
// straight into the e2e database, so the jobs the demo web search finds stay untouched for other specs.
//
// Gestures: Chromium gets real touch input through CDP (Input.dispatchTouchEvent), so touch-action and
// native scrolling are exercised for real. WebKit has no such API in Playwright; there the gesture is a
// sequence of touch events dispatched in the page (plus the click a browser may send after the finger
// lifts). Synthetic events don't scroll and mobile WebKit has no wheel, so on WebKit the vertical-drag
// test only checks that the row never moves and leaves vertical panning to the browser (touch-action).
import path from "node:path";
import Database from "better-sqlite3";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const FILTERS = {
  titles: ["Swipe Tester"],
  keywords: [],
  locations: [{ country: "AU", city: "Sydney" }],
  workplace: [],
  employmentTypes: [],
  seniority: [],
  salaryMin: null,
  postedWithinDays: null,
  excludeKeywords: [],
};

function openDb() {
  const db = new Database(path.join(process.env.HUNTLOOP_E2E_DATA_DIR!, "huntloop.db"), { fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

let counter = 0;
/** Listing link of every seeded job, by id. */
const seededUrls = new Map<number, string>();
/** Searches seeded by the current test; removed afterwards so they don't crowd later specs out of "Your searches". */
const seededSearches: number[] = [];

test.afterEach(() => {
  const db = openDb();
  try {
    for (const id of seededSearches.splice(0)) {
      db.prepare("delete from job_sightings where search_id = ?").run(id);
      db.prepare("delete from searches where id = ?").run(id);
    }
  } finally {
    db.close();
  }
});

type SeedJob = { status?: string; intakeStatus?: string };

/** A search with `jobs.length` results (unscored, so they list under "Not scored yet"). */
function seedSearch(jobs: SeedJob[]): { searchId: number; ids: number[] } {
  const label = `Swipe ${test.info().project.name} ${Date.now().toString(36)}${counter++}`;
  const db = openDb();
  try {
    return db.transaction(() => {
      const { id: userId } = db.prepare("select id from users order by id limit 1").get() as { id: number };
      const now = Date.now();
      const searchId = Number(
        db
          .prepare("insert into searches (user_id, query, filters, sources, last_run_at) values (?, ?, ?, ?, ?)")
          .run(userId, label, JSON.stringify(FILTERS), JSON.stringify(["web_agent"]), now).lastInsertRowid,
      );
      const ids = jobs.map((job, i) => {
        const url = `https://swipe.example/${encodeURIComponent(label)}/${i}`;
        const id = Number(
          db
            .prepare(
              `insert into jobs (user_id, source, source_url, title, company_name, location_text, country, description, description_is_full, intake_status, status, updated_at)
               values (?, 'web_agent', ?, ?, ?, 'Sydney NSW', 'AU', 'A demo posting for the swipe tests.', 0, ?, ?, ?)`,
            )
            .run(userId, url, `Swipe Tester ${i}`, `${label} Co ${i}`, job.intakeStatus ?? "ready", job.status ?? "new", now).lastInsertRowid,
        );
        db.prepare("insert into job_sightings (job_id, search_id, source, url, rank) values (?, ?, 'web_agent', ?, ?)").run(id, searchId, url, i);
        seededUrls.set(id, url);
        return id;
      });
      seededSearches.push(searchId);
      return { searchId, ids };
    })();
  } finally {
    db.close();
  }
}

function jobExists(id: number): boolean {
  const db = openDb();
  try {
    return (db.prepare("select count(*) as n from jobs where id = ?").get(id) as { n: number }).n === 1;
  } finally {
    db.close();
  }
}

/** Times the seeded job's listing link is remembered as deleted (so later searches skip it). */
function dismissedCount(id: number): number {
  const db = openDb();
  try {
    return (db.prepare("select count(*) as n from dismissed_jobs where source_url = ?").get(seededUrls.get(id)) as { n: number }).n;
  } finally {
    db.close();
  }
}

const row = (page: Page, id: number) => page.locator(`[data-swipe-row="${id}"]`);
const toast = (page: Page) => page.locator("[data-swipe-toast]");
const undoButton = (page: Page) => page.getByRole("button", { name: "Undo", exact: true });

async function openSearch(page: Page, searchId: number) {
  await page.goto(`/search/${searchId}`);
  await expect(page.locator("[data-swipe-row]").first()).toBeVisible();
  // WebKit reports link prefetches cut off by a later navigation as uncaught errors; let them finish.
  await page.waitForLoadState("networkidle");
}

type Point = { dx: number; dy: number };

/**
 * One finger from (x, y) through `points` (offsets from the start), `ms` in all. Chromium: real touch input
 * (CDP). WebKit: touch events dispatched at the element under the finger, then (with `click`) the click a
 * browser may send after the finger lifts, so the swipe's click suppression is tested there too.
 */
async function gesture(page: Page, from: { x: number; y: number }, points: Point[], ms: number, click = false, cancel = false) {
  if (test.info().project.name === "iphone") {
    await page.evaluate(
      async ({ from, points, ms, click, cancel }) => {
        const target = document.elementFromPoint(from.x, from.y);
        if (!target) throw new Error("nothing under the finger");
        // WebKit's Touch constructor is off limits to pages, so the touch lists are plain objects on an Event.
        const fire = (type: string, x: number, y: number) => {
          const t = { identifier: 7, target, clientX: x, clientY: y, pageX: x + scrollX, pageY: y + scrollY };
          const ended = type === "touchend" || type === "touchcancel";
          const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
          for (const [key, list] of Object.entries({ touches: ended ? [] : [t], targetTouches: ended ? [] : [t], changedTouches: [t] })) {
            Object.defineProperty(event, key, { value: list });
          }
          target.dispatchEvent(event);
        };
        fire("touchstart", from.x, from.y);
        let last = { dx: 0, dy: 0 };
        for (const p of points) {
          await new Promise((r) => setTimeout(r, ms / points.length));
          fire("touchmove", from.x + p.dx, from.y + p.dy);
          last = p;
        }
        fire(cancel ? "touchcancel" : "touchend", from.x + last.dx, from.y + last.dy);
        if (click) target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, detail: 1, clientX: from.x + last.dx, clientY: from.y + last.dy }));
      },
      { from, points, ms, click, cancel },
    );
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
    for (const p of points) {
      await page.waitForTimeout(ms / points.length);
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + p.dx, y: from.y + p.dy }] });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: cancel ? "touchCancel" : "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

/** A straight drag by (dx, dy) in `steps` even moves. */
async function drag(page: Page, from: { x: number; y: number }, delta: Point, ms: number, steps = 12, click = false) {
  const points = Array.from({ length: steps }, (_, i) => ({ dx: (delta.dx * (i + 1)) / steps, dy: (delta.dy * (i + 1)) / steps }));
  await gesture(page, from, points, ms, click);
}

/** Watches a row's sliding part: true once it has moved sideways at all. */
async function watchSideways(target: Locator) {
  await target.locator("[data-swipe-track]").evaluate((el) => {
    const w = window as unknown as { swipeMoved: boolean };
    w.swipeMoved = false;
    new MutationObserver(() => {
      if (/translateX\(-/.test(el.getAttribute("style") ?? "")) w.swipeMoved = true;
    }).observe(el, { attributes: true, attributeFilter: ["style"] });
  });
  return async () => target.page().evaluate(() => (window as unknown as { swipeMoved: boolean }).swipeMoved);
}

/** Swipe a row left by `share` of its width; slowly (no flick) unless `ms` says otherwise. */
async function swipeLeft(page: Page, target: Locator, share: number, ms = 700, steps = 12, click = true) {
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await drag(page, { x: box.x + box.width * 0.9, y: box.y + box.height / 2 }, { dx: -box.width * share, dy: 0 }, ms, steps, click);
}

test("swipe past the threshold deletes after the Undo window; Undo brings the row back", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}, {}]);
  await openSearch(page, searchId);

  // Past the threshold (slowly, so it's distance, not a flick): the row slides out and the toast appears.
  await swipeLeft(page, row(page, ids[0]), 0.6);
  await expect(row(page, ids[0])).toHaveCount(0);
  await expect(toast(page)).toContainText("Deleted");
  await expect(page.getByRole("status").filter({ has: undoButton(page) })).toHaveAttribute("aria-live", "polite");

  // Undo: the row is back and the job was never deleted.
  await undoButton(page).click();
  await expect(row(page, ids[0])).toBeVisible();
  await expect(toast(page)).toHaveCount(0);
  await expect(row(page, ids[0]).locator("[data-swipe-track]")).not.toHaveAttribute("style", /translateX/);
  await page.waitForTimeout(5_500);
  expect(jobExists(ids[0])).toBe(true);
  expect(dismissedCount(ids[0])).toBe(0);

  // A fast flick also counts, even though it's short of the distance threshold. Left alone, the delete is sent after ~5 s.
  await swipeLeft(page, row(page, ids[1]), 0.17, 40, 4);
  await expect(row(page, ids[1])).toHaveCount(0);
  await expect(toast(page)).toBeVisible();
  expect(jobExists(ids[1])).toBe(true);
  await expect(toast(page)).toHaveCount(0, { timeout: 8_000 });
  await expect.poll(() => jobExists(ids[1]), { timeout: 5_000 }).toBe(false);
  // The bulk delete remembers the listing, so running a search again won't bring it back.
  expect(dismissedCount(ids[1])).toBe(1);
  // After the refresh the server list no longer has it either.
  await page.reload();
  await expect(row(page, ids[1])).toHaveCount(0);
  await expect(row(page, ids[2])).toBeVisible();
});

test("a long, slow drag that drifts up and down still deletes", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}]);
  await openSearch(page, searchId);
  const target = row(page, ids[0]);
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  // 2 s, 40 moves: first clearly sideways, then the thumb wanders 40 px down and 25 px back up while still going left.
  const points = Array.from({ length: 40 }, (_, i) => {
    const f = (i + 1) / 40;
    const dy = f < 0.25 ? 0 : f < 0.7 ? ((f - 0.25) / 0.45) * 40 : 40 - ((f - 0.7) / 0.3) * 25;
    return { dx: -box.width * 0.55 * f, dy };
  });
  await gesture(page, { x: box.x + box.width * 0.9, y: box.y + box.height / 2 }, points, 2_000, true);
  await expect(target).toHaveCount(0);
  await expect(toast(page)).toBeVisible();
});

test("a touch cancelled by the browser after the swipe started is decided by distance", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}, {}]);
  await openSearch(page, searchId);
  for (const [id, share, deleted] of [[ids[0], 0.1, false], [ids[1], 0.5, true]] as const) {
    const target = row(page, id);
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    const points = Array.from({ length: 12 }, (_, i) => ({ dx: (-box.width * share * (i + 1)) / 12, dy: 0 }));
    await gesture(page, { x: box.x + box.width * 0.9, y: box.y + box.height / 2 }, points, 700, false, true);
    if (deleted) await expect(target).toHaveCount(0);
    else await expect(target.locator("[data-swipe-track]")).not.toHaveAttribute("style", /translateX\(-/);
  }
  await expect(row(page, ids[2])).toBeVisible();
});

test("a slow drag of 30% of the row deletes", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}]);
  await openSearch(page, searchId);
  await swipeLeft(page, row(page, ids[0]), 0.3, 900);
  await expect(row(page, ids[0])).toHaveCount(0);
  await expect(toast(page)).toBeVisible();
});

test("a pinch with one finger on each of two rows never swipes either", async ({ page }) => {
  test.skip(test.info().project.name === "iphone", "needs real multi-touch input (CDP); WebKit has none in Playwright");
  const { searchId, ids } = seedSearch([{}, {}, {}]);
  await openSearch(page, searchId);
  const [a, b] = [row(page, ids[0]), row(page, ids[1])];
  await a.scrollIntoViewIfNeeded();
  const movedA = await watchSideways(a);
  const boxA = (await a.boundingBox())!;
  const boxB = (await b.boundingBox())!;
  // Finger A lands on row 1 first; finger B lands on row 2 a moment later (row 1 never hears B's touchstart).
  const fingerA = { x: boxA.x + boxA.width * 0.8, y: boxA.y + boxA.height / 2, id: 0 };
  const fingerB = { x: boxB.x + boxB.width * 0.3, y: boxB.y + boxB.height / 2, id: 1 };
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [fingerA] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [fingerA, fingerB] });
    // Spread apart: A goes left (mostly sideways, as a swipe would), B goes right and down.
    for (let i = 1; i <= 12; i++) {
      await page.waitForTimeout(40);
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { ...fingerA, x: fingerA.x - i * 12, y: fingerA.y - i * 2 },
          { ...fingerB, x: fingerB.x + i * 10, y: fingerB.y + i * 6 },
        ],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await page.waitForTimeout(500);
  expect(await movedA()).toBe(false);
  await expect(toast(page)).toHaveCount(0);
  expect(jobExists(ids[0]) && jobExists(ids[1])).toBe(true);
});

test("a tiny accidental sideways move doesn't start a swipe", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}]);
  await openSearch(page, searchId);
  const target = row(page, ids[0]);
  await target.scrollIntoViewIfNeeded();
  const moved = await watchSideways(target);
  const box = (await target.boundingBox())!;
  await drag(page, { x: box.x + box.width * 0.6, y: box.y + box.height / 2 }, { dx: -10, dy: 3 }, 300, 5);
  await page.waitForTimeout(300);
  // (A browser may take a move this small for a tap and open the job; it must never slide or delete.)
  expect(await moved()).toBe(false);
  await expect(toast(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  expect(jobExists(ids[0])).toBe(true);
});

test("a short swipe snaps back; a tap still opens the job", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}]);
  await openSearch(page, searchId);
  const target = row(page, ids[0]);

  await swipeLeft(page, target, 0.15);
  await expect(target.locator("[data-swipe-track]")).not.toHaveAttribute("style", /translateX\(-/);
  await expect(target).toBeVisible();
  await expect(toast(page)).toHaveCount(0);
  // The swipe's release didn't open the job.
  await expect(page).toHaveURL(new RegExp(`/search/${searchId}$`));
  expect(jobExists(ids[0])).toBe(true);

  const box = (await target.boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(new RegExp(`/jobs/${ids[0]}$`));
});

test("a vertical drag scrolls the page and never swipes the row", async ({ page }) => {
  const { searchId, ids } = seedSearch(Array.from({ length: 14 }, () => ({})));
  await openSearch(page, searchId);
  const target = row(page, ids[2]);
  await target.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => window.scrollY);
  const box = (await target.boundingBox())!;

  // Note every inline transform the row gets during the drag: it must never move sideways, not even briefly.
  const moved = await watchSideways(target);

  // Mostly vertical with a little sideways drift, as a real thumb does.
  await drag(page, { x: box.x + box.width * 0.7, y: box.y + box.height / 2 }, { dx: -30, dy: -250 }, 400);
  await page.waitForTimeout(500);
  expect(await moved()).toBe(false);
  await expect(toast(page)).toHaveCount(0);
  // The row leaves vertical panning to the browser.
  expect(await target.locator("[data-swipe-track]").evaluate((el) => getComputedStyle(el).touchAction)).toBe("pan-y pinch-zoom");
  if (test.info().project.name !== "iphone") {
    // Real touch input (Chromium): the page actually scrolled. Playwright can't scroll mobile WebKit by touch.
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(before + 50);
  }
  expect(jobExists(ids[2])).toBe(true);
  await expect(target).toBeVisible();
});

test("in-progress jobs and jobs still being read can't be swiped", async ({ page }) => {
  const { searchId, ids } = seedSearch([{ status: "applied" }, { intakeStatus: "processing" }, {}]);
  await openSearch(page, searchId);
  await expect(row(page, ids[0])).toHaveAttribute("data-swipeable", "false");
  await expect(row(page, ids[1])).toHaveAttribute("data-swipeable", "false");
  await expect(row(page, ids[2])).toHaveAttribute("data-swipeable", "true");

  for (const id of ids.slice(0, 2)) {
    // No click afterwards: without the swipe handlers a sideways drag is not a tap.
    await swipeLeft(page, row(page, id), 0.7, 700, 12, false);
    await expect(row(page, id).locator("[data-swipe-track]")).not.toHaveAttribute("style", /translateX/);
    await expect(row(page, id)).toBeVisible();
  }
  await expect(toast(page)).toHaveCount(0);
  expect(jobExists(ids[0]) && jobExists(ids[1])).toBe(true);
});

/** Each delete below must land well inside the 5 s Undo window (counted from the swipe), so only an immediate send passes. */
async function deletedSoon(id: number, since: number) {
  await expect.poll(() => jobExists(id), { timeout: 4_000 }).toBe(false);
  expect(Date.now() - since, "deleted by the Undo timer, not by the immediate send").toBeLessThan(4_000);
}

test("leaving right after the release (during the slide-out) still deletes", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}]);
  await openSearch(page, searchId);
  const swipedAt = Date.now();
  await swipeLeft(page, row(page, ids[0]), 0.6);
  // Navigate within a few ms of the finger lifting, before the 200 ms slide-out has finished.
  await page.evaluate(() => document.querySelector<HTMLAnchorElement>('a[href="/search"]')!.click());
  await expect(page).toHaveURL(/\/search$/);
  await deletedSoon(ids[0], swipedAt);
});

test("a row whose delete was sent stays gone when Back restores the list", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}]);
  await openSearch(page, searchId);
  await swipeLeft(page, row(page, ids[0]), 0.6);
  await expect(toast(page)).toBeVisible();
  // Open another job during the Undo window: the delete is sent as the list unmounts (no refresh happens).
  await row(page, ids[1]).scrollIntoViewIfNeeded();
  const box = (await row(page, ids[1]).boundingBox())!;
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page).toHaveURL(new RegExp(`/jobs/${ids[1]}$`));
  await expect.poll(() => jobExists(ids[0]), { timeout: 4_000 }).toBe(false);
  // Back may come from the client router cache, rendered before the delete.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/search/${searchId}$`));
  await expect(row(page, ids[1])).toBeVisible();
  await expect(row(page, ids[0])).toHaveCount(0);
  await expect(toast(page)).toHaveCount(0);
});

test("a second swipe or leaving the page sends the waiting delete at once", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}, {}]);
  await openSearch(page, searchId);
  await swipeLeft(page, row(page, ids[0]), 0.6);
  await expect(toast(page)).toBeVisible();

  const firstAt = Date.now();

  // Second swipe while the first is waiting: the first is sent straight away.
  await swipeLeft(page, row(page, ids[1]), 0.6);
  const secondAt = Date.now();
  await deletedSoon(ids[0], firstAt);
  expect(jobExists(ids[1])).toBe(true);

  // In-app navigation (the list unmounts).
  await page.getByRole("link", { name: "All searches" }).click();
  await expect(page).toHaveURL(/\/search$/);
  await deletedSoon(ids[1], secondAt);

  // A full page load (pagehide): the page's own timer dies with it, so only the send on leaving can delete.
  await openSearch(page, searchId);
  await swipeLeft(page, row(page, ids[2]), 0.6);
  await expect(toast(page)).toBeVisible();
  await page.goto("/search");
  await page.waitForTimeout(6_000);
  expect(jobExists(ids[2])).toBe(false);
  // Back (possibly from the back/forward cache): no stale "Deleted · Undo" for a delete already sent.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/search/${searchId}$`));
  await expect(toast(page)).toHaveCount(0);
});

test("a failed delete is reported without hiding the next row's Undo", async ({ page }) => {
  const { searchId, ids } = seedSearch([{}, {}]);
  await openSearch(page, searchId);
  // The server refuses the first delete only.
  let calls = 0;
  await page.route("**/api/jobs", (route) => (route.request().method() === "DELETE" && calls++ === 0 ? route.fulfill({ status: 500, body: "{}" }) : route.fallback()));

  await swipeLeft(page, row(page, ids[0]), 0.6);
  await swipeLeft(page, row(page, ids[1]), 0.6);
  // The first row comes back with a notice; the second row's Undo is still there and still works.
  await expect(page.locator("[data-swipe-notice]")).toHaveText("Couldn't delete the job. It's back in the list.");
  await expect(row(page, ids[0])).toBeVisible();
  await expect(undoButton(page)).toBeVisible();
  await undoButton(page).click();
  await expect(row(page, ids[1])).toBeVisible();
  await page.waitForTimeout(5_500);
  expect(jobExists(ids[0]) && jobExists(ids[1])).toBe(true);
});
