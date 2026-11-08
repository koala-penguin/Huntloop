// Runs in the `cleanup` project after every other spec (playwright.config.ts): it deletes every job the
// other specs created. Nothing may depend on jobs existing after it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// This spec deletes data. Refuse to run against anything but the throwaway e2e server and data folder.
test.beforeAll(({}, testInfo) => {
  const dir = process.env.HUNTLOOP_E2E_DATA_DIR;
  const tmpRoots = [os.tmpdir(), fs.realpathSync(os.tmpdir())].map((p) => p + path.sep);
  expect(dir, "HUNTLOOP_E2E_DATA_DIR must be set").toBeTruthy();
  expect(
    tmpRoots.some((root) => path.resolve(dir!).startsWith(root)),
    `HUNTLOOP_E2E_DATA_DIR must be under the temp folder, got ${dir}`,
  ).toBe(true);
  const baseURL = testInfo.project.use.baseURL;
  expect(baseURL, "baseURL must be set").toBeTruthy();
  expect(new URL(baseURL!).port, "never the live app port").not.toBe("3000");
});

test("bulk delete API rejects bad requests and reports unknown ids", async ({ request }) => {
  const empty = await request.delete("/api/jobs", { data: { ids: [] } });
  expect(empty.status()).toBe(400);
  expect(await empty.json()).toEqual({ error: "invalid" });

  expect((await request.delete("/api/jobs", { data: { ids: "x" } })).status()).toBe(400);

  const notJson = await request.delete("/api/jobs", { data: "not json", headers: { "content-type": "application/json" } });
  expect(notJson.status()).toBe(400);
  const notJsonType = await request.delete("/api/jobs", { data: "ids=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
  expect(notJsonType.status()).toBe(400);
  const smuggled = await request.delete("/api/jobs", { data: JSON.stringify({ ids: [999999] }), headers: { "content-type": "text/plain; x=application/json" } });
  expect(smuggled.status()).toBe(400);

  const unknown = await request.delete("/api/jobs", { data: { ids: [999999] } });
  expect(unknown.status()).toBe(200);
  expect(await unknown.json()).toEqual({ deleted: [], skipped: [{ id: 999999, reason: "not_found" }] });
});

const selectAllBox = (page: Page) => page.getByRole("checkbox", { name: /^Select all \d+ shown$/ });
const selectedCount = (page: Page) => page.getByRole("status").filter({ hasText: /^\d+ selected$/ });

test("a filter change starts with nothing selected", async ({ page }) => {
  await page.goto("/jobs?ineligible=1");
  const total = await page.locator("ul[data-job-list] > li").count();
  await selectAllBox(page).check();
  await expect(selectedCount(page)).toHaveText(`${total} selected`);

  const statusFilter = page.getByRole("group", { name: "Filter by status" });
  await statusFilter.getByRole("link", { name: "Active", exact: true }).click();
  await expect(page).toHaveURL(/status=active/);
  await expect(selectedCount(page)).toHaveText("0 selected");

  // Back on the full list, the ticks made before the switch are gone too, so they can't be deleted unseen.
  await statusFilter.getByRole("link", { name: "All", exact: true }).click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(selectedCount(page)).toHaveText("0 selected");
  await expect(page.getByRole("button", { name: "Delete selected", exact: true })).toBeDisabled();
});

test("the confirm panel closes when nothing is selected, and Escape closes it from the bar or a row", async ({ page }) => {
  await page.goto("/jobs?ineligible=1");
  const selectAll = selectAllBox(page);
  const deleteSelected = page.getByRole("button", { name: "Delete selected", exact: true });
  const dialog = page.getByRole("alertdialog");
  const firstRow = page.locator("ul[data-job-list] > li").first().getByRole("checkbox");

  await selectAll.check();
  await deleteSelected.click();
  await expect(dialog).toBeVisible();
  await selectAll.uncheck();
  await expect(dialog).toHaveCount(0);
  await firstRow.check();
  await expect(dialog).toHaveCount(0);

  await deleteSelected.click();
  await expect(dialog).toBeVisible();
  await selectAll.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await deleteSelected.click();
  await expect(dialog).toBeVisible();
  await firstRow.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(firstRow).toBeChecked();
});

test("select all, keep jobs in progress, then delete everything", async ({ page }) => {
  await page.goto("/jobs?ineligible=1");
  const rows = page.locator("ul[data-job-list] > li");
  const total = await rows.count();
  expect(total).toBeGreaterThan(0);
  await expect(page.getByRole("checkbox", { name: /^Select / }).first()).toBeVisible();
  // Every row checkbox has its own name, even when titles repeat.
  const rowNames = await rows.getByRole("checkbox").evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
  expect(rowNames).toHaveLength(total);
  expect(new Set(rowNames).size, rowNames.join("\n")).toBe(total);

  const selectAll = page.getByRole("checkbox", { name: /^Select all \d+ shown$/ });
  await selectAll.check();
  await expect(page.getByRole("status").filter({ hasText: new RegExp(`^${total} selected$`) })).toBeVisible();

  const deleteSelected = page.getByRole("button", { name: "Delete selected", exact: true });
  await deleteSelected.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(selectAll).toBeChecked();
  await expect(deleteSelected).toBeFocused();

  // Without the extra tick, jobs in progress stay (earlier specs leave at least one).
  await deleteSelected.click();
  const include = dialog.getByRole("checkbox", { name: /Also delete \d+ jobs? in progress/ });
  const label = await dialog.locator("label").filter({ hasText: /Also delete/ }).innerText();
  const inProgress = Number(/Also delete (\d+) jobs? in progress/.exec(label)?.[1]);
  expect(inProgress).toBeGreaterThan(0);
  const deletable = total - inProgress;
  await expect(dialog.getByText(`Delete ${deletable} ${deletable === 1 ? "job" : "jobs"}?`, { exact: true })).toBeVisible();
  await expect(include).not.toBeChecked();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(rows).toHaveCount(inProgress);
  // Focus moves to the result, not to <body>.
  await expect(page.getByRole("status").filter({ hasText: /in progress (was|were) kept/ })).toBeFocused();

  // With it, everything goes.
  await selectAll.check();
  await deleteSelected.click();
  await expect(dialog.getByText("Every selected job is in progress.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await include.check();
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  await expect(page.getByText("No jobs here yet.")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /deleted\./ })).toBeFocused();
  await expect(page.getByText(/not eligible for (is|are) hidden/)).toHaveCount(0);

  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("running a search again doesn't bring deleted jobs back", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("link", { name: /senior frontend engineer in Sydney, hybrid/ }).first().click();
  await expect(page).toHaveURL(/\/search\/\d+$/);
  await page.getByRole("button", { name: "Run again" }).click();
  await expect(page.getByText(/^Left out: .*\d+ deleted by you before/)).toBeVisible({ timeout: 30_000 });
  await page.getByText(/^Show the \d+ left out$/).click();
  await expect(page.locator("[data-rejected]").getByText("deleted by you before").first()).toBeVisible();
  await page.goto("/jobs?ineligible=1");
  await expect(page.getByText("No jobs here yet.")).toBeVisible();
});

test("the empty list reads in Korean", async ({ page }) => {
  await page.goto("/jobs");
  await page.context().addCookies([{ name: "NEXT_LOCALE", value: "ko", url: page.url() }]);
  await page.reload();
  await expect(page.getByText("아직 공고가 없습니다.")).toBeVisible();
});
