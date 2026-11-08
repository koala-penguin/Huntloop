import { expect, test } from "./fixtures";

test("search: request → filters → ranked results → run again → open a job", async ({ page }) => {
  await page.goto("/search");
  await expect(page.getByRole("heading", { name: "Find jobs" })).toBeVisible();
  await page.getByRole("textbox", { name: "What are you looking for?" }).fill("senior frontend engineer in Sydney, hybrid");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/search\/\d+$/);

  // The run happens in the background; the page refreshes with results grouped by Interview Chance.
  const tidewater = page.locator("[data-result]").filter({ hasText: "Tidewater Labs" });
  await expect(tidewater).toBeVisible({ timeout: 30_000 });
  await expect(tidewater.getByText("New")).toBeVisible();
  await expect(tidewater.getByText("Provisional")).toBeVisible();
  await expect(tidewater.getByText("Web search")).toBeVisible();
  await expect(page.getByRole("list", { name: "Search filters" }).getByText("Sydney, Australia")).toBeVisible();
  await expect(page.getByText("Web search: 2 jobs found")).toBeVisible();
  // The leads that were left out are listed with their reasons.
  await page.getByText(/^Show the \d+ left out$/).click();
  await expect(page.getByText("Unseen Co")).toBeVisible();

  // Edit the filters and run again: the same jobs are recognised, so nothing is "New".
  await page.getByRole("button", { name: "Edit filters" }).click();
  await page.getByRole("textbox", { name: "Must mention" }).fill("React");
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "Save and run" }).click();
  await expect(page.getByRole("list", { name: "Search filters" }).getByText("+ React")).toBeVisible({ timeout: 30_000 });
  await expect(tidewater).toBeVisible();
  await expect(tidewater.getByText("New")).toHaveCount(0);

  await tidewater.click();
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible();

  await page.goto("/search");
  await expect(page.getByRole("link", { name: /senior frontend engineer in Sydney, hybrid/ })).toBeVisible();
});

test("search: deleting a search asks first", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("textbox", { name: "What are you looking for?" }).fill("temporary search to delete");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/search\/\d+$/);
  const url = page.url();
  // Wait for the background run to finish so nothing is still writing results for this search.
  await expect(page.getByText(/Web search: \d+ jobs? found/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Delete search" }).click();
  await expect(page.getByText(/Delete this search, its daily check and its results list\?/)).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page).toHaveURL(url);
  await expect(page.getByText(/Delete this search, its daily check/)).toHaveCount(0);

  await page.getByRole("button", { name: "Delete search" }).click();
  await page.getByRole("button", { name: "Delete search" }).click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.getByRole("link", { name: /temporary search to delete/ })).toHaveCount(0);
});

test("search: an empty query asks before using your saved preferences", async ({ page }) => {
  await page.goto("/search");
  const submit = page.getByRole("button", { name: "Search", exact: true });
  const prefs = page.getByRole("button", { name: "Search with my preferences" });
  const box = page.getByRole("textbox", { name: "What are you looking for?" });
  // Empty (or whitespace) query: the button says what will happen.
  await expect(prefs).toBeVisible();
  await box.fill("   ");
  await expect(prefs).toBeVisible();
  const links = page.getByRole("link", { name: "Jobs matching my preferences" });
  const before = await links.count();

  // No: the dialog closes and nothing is created.
  await prefs.click();
  const dialog = page.getByRole("alertdialog", { name: "Search with your saved job preferences?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "No" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/search$/);
  await expect(links).toHaveCount(before);

  // Enter in the box asks the same question; Escape closes it.
  await box.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/search$/);

  // Typing while it is open closes it, so Yes can never search typed text under the "preferences" question.
  await prefs.click();
  await expect(dialog).toBeVisible();
  await box.pressSequentially("x");
  await expect(dialog).toHaveCount(0);
  await box.fill("");

  // Yes: the search is created.
  await prefs.click();
  await dialog.getByRole("button", { name: "Yes" }).click();
  await expect(page).toHaveURL(/\/search\/\d+$/);

  // A typed query: plain label, no dialog.
  await page.goto("/search");
  await box.fill("data engineer in Wellington");
  await expect(prefs).toHaveCount(0);
  await submit.click();
  await expect(page).toHaveURL(/\/search\/\d+$/);
  await expect(dialog).toHaveCount(0);
});
