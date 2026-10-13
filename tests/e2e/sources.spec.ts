import { expect, test } from "./fixtures";

const SITES = `http://127.0.0.1:${process.env.E2E_SITES_PORT ?? 3299}`;

test("SEEK through Huntloop's browser: opt in, read a pasted link, search, pause on a CAPTCHA", async ({ page, request }) => {
  await request.get(`${SITES}/__reset`);

  // Opt in: the risk notice comes first.
  await page.goto("/settings");
  const seek = page.locator('[data-site="seek"]');
  // Ticking the box only shows the risk notice; nothing is turned on until the user accepts it.
  await seek.getByRole("checkbox", { name: "Use SEEK (Australia and New Zealand)" }).click();
  await expect(seek.getByRole("alertdialog", { name: "Before you turn this on" })).toBeVisible();
  await expect(seek.getByRole("checkbox", { name: "Use SEEK (Australia and New Zealand)" })).not.toBeChecked();
  await seek.getByRole("button", { name: "I understand — turn it on" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-site="seek"]').getByRole("checkbox", { name: "Use SEEK (Australia and New Zealand)" })).toBeChecked();
  await page.getByRole("button", { name: "Test the browser window" }).click();
  await expect(page.getByText("The browser window works.")).toBeVisible({ timeout: 30_000 });

  // A pasted SEEK link is now read in the browser instead of asking for the text.
  await page.goto("/jobs");
  await page.getByRole("textbox", { name: "Job link or posting text" }).fill("https://www.seek.com.au/job/81000002");
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Frontend Developer" })).toBeVisible();
  await expect(page.getByText("SEEK", { exact: true })).toBeVisible();

  // A search now includes SEEK, read in full (not provisional).
  await page.goto("/search");
  await page.getByRole("textbox", { name: "What are you looking for?" }).fill("frontend engineer in Sydney");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  const harbour = page.locator("[data-result]").filter({ hasText: "Harbour Lights Health" });
  await expect(harbour).toBeVisible({ timeout: 45_000 });
  await expect(harbour.getByText("SEEK")).toBeVisible();
  await expect(harbour.getByText("Provisional")).toHaveCount(0);
  await expect(page.getByText("SEEK: 3 jobs found")).toBeVisible();

  // Run again with a CAPTCHA on one job page: the run pauses and asks the user.
  await request.get(`${SITES}/__captcha?on=1`);
  await page.getByRole("button", { name: "Run again" }).click();
  const prompt = page.getByRole("alert").filter({ hasText: "Action needed in Huntloop's browser window" });
  await expect(prompt).toBeVisible({ timeout: 45_000 });
  await expect(prompt.getByText(/SEEK is showing a check/)).toBeVisible();
  await request.get(`${SITES}/__solve`); // the user completes the check in the window
  await prompt.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("SEEK: 3 jobs found")).toBeVisible({ timeout: 45_000 });
});
