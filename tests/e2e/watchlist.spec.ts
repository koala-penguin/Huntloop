import { expect, test } from "./fixtures";

test("save a search with a daily check; it stays at the top of Search", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("textbox", { name: "What are you looking for?" }).fill("frontend roles in Sydney");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/\/search\/\d+$/);

  const card = page.locator("[data-saved-search]");
  await card.getByRole("textbox", { name: "Name" }).fill("Frontend Sydney");
  await card.getByRole("checkbox", { name: /Check daily/ }).check();
  await card.getByRole("button", { name: "Save search" }).click();
  await expect(page.getByRole("heading", { name: "Saved search" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Frontend Sydney" })).toBeVisible();

  await page.goto("/search");
  const saved = page.locator("[data-saved-searches]").getByRole("link", { name: /Frontend Sydney/ });
  await expect(saved).toBeVisible();
  await expect(saved.getByText("Daily")).toBeVisible();
});

test("watch an employer's job board: matching roles, add one and assess it", async ({ page }) => {
  await page.goto("/search");
  await page.getByRole("link", { name: "Watch an employer's job board" }).click();
  await page.getByRole("textbox", { name: "Job board link" }).fill("https://boards.greenhouse.io/acme");
  await page.getByRole("button", { name: "Watch", exact: true }).click();

  const board = page.locator('[data-watch="acme"]');
  await expect(board.getByText("3 open, 1 fit your preferences")).toBeVisible({ timeout: 30_000 });
  const match = board.locator('[data-opening="701"]');
  await expect(match.getByText("Fits your preferences")).toBeVisible();
  await board.getByText("2 other open roles").click();
  await expect(board.locator('[data-opening="702"]').getByText("Outside your countries")).toBeVisible();

  // Adding a role reads the full posting from the board and assesses it.
  await match.getByRole("button", { name: "Add & assess" }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+/);
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Senior Frontend Engineer" })).toBeVisible();

  // The job's employer is now known to be watched.
  await page.getByRole("tab", { name: "Employer" }).click();
  await expect(page.getByText("You're watching Acme Robotics's job board.").or(page.getByText(/You're watching .*job board/))).toBeVisible();

  await page.goto("/search/watchlist");
  await expect(page.locator('[data-opening="701"]').getByRole("link", { name: "Open job" })).toBeVisible();
});
