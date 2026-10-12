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
