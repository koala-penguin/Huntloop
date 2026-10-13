import { expect, test } from "./fixtures";

test("usage: from the dashboard to spend per day, task and model", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "See where it went" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "AI usage" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Daily AI spend over the last 30 days" })).toBeVisible();
  // Earlier flows ran in demo mode: counted, never billed.
  await expect(page.getByText(/answered in demo mode and cost nothing/)).toBeVisible();
  // The profile flow read a CV.
  await expect(page.locator('[data-usage-row="extractProfile"]').getByRole("cell", { name: "Read your CV" })).toBeVisible();

  // Focusing a day shows its details.
  const today = page.locator("[data-day]").last();
  await today.focus();
  await expect(page.getByRole("status").filter({ hasText: /calls?$/ })).toBeVisible();

  await page.getByText("Show as a table").click();
  await expect(page.getByRole("columnheader", { name: "Date" })).toBeVisible();
});
