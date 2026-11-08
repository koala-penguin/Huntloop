import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

const POSTING = fs.readFileSync(path.join(__dirname, "../fixtures/postings/screenshot-posting.txt"), "utf8").replace("Bright Harbour Health", "Coach Test Co");

test("coach: answers about the whole pipeline using its tools", async ({ page }) => {
  await page.goto("/jobs");
  await page.getByRole("textbox", { name: "Job link or posting text" }).fill(POSTING);
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 30_000 });

  await page.getByRole("link", { name: "Coach" }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Coach" })).toBeVisible();
  await page.getByRole("button", { name: "What should I focus on this week?" }).click();

  // The coach looked through the jobs (a tool call) and answered from them.
  await expect(page.getByText("Looked through your jobs")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-role="assistant"]').getByText(/Coach Test Co/).first()).toBeVisible();

  // A follow-up in the same conversation; then a fresh one.
  await page.getByRole("textbox", { name: "Message" }).fill("Thanks!");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-role="user"]').filter({ hasText: "Thanks!" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "New conversation" }).click();
  await expect(page.getByRole("button", { name: "What should I focus on this week?" })).toBeVisible();
});
