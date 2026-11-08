import fs from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";

const POSTING = fs.readFileSync(path.join(__dirname, "../fixtures/postings/screenshot-posting.txt"), "utf8").replace("Bright Harbour Health", "Pipeline Test Co");

test("pipeline: move a job through stages with outcomes, see its history and how tiers turn out", async ({ page }) => {
  await page.goto("/jobs");
  await page.getByRole("textbox", { name: "Job link or posting text" }).fill(POSTING);
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 30_000 });
  const jobUrl = page.url();

  // Shortlisting is immediate; applying asks for optional details.
  const status = page.getByRole("combobox", { name: "Status" });
  await status.selectOption("shortlisted");
  await expect(status).toHaveValue("shortlisted");
  await status.selectOption("applied");
  const form = page.locator('[data-outcome-form="applied"]');
  await expect(form.getByText("You applied — any details?")).toBeVisible();
  await form.getByRole("combobox", { name: "How you applied" }).selectOption("referral");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(form).toHaveCount(0);
  await expect(status).toHaveValue("applied");

  // The board shows it under Applied; moving it on records the interview round.
  await page.getByRole("link", { name: "Pipeline" }).first().click();
  const applied = page.locator('[data-pipeline-column="applied"]');
  const card = applied.locator("[data-pipeline-job]").filter({ hasText: "Pipeline Test Co" });
  await expect(card).toBeVisible();
  await expect(card.getByText(/^Applied /)).toBeVisible();
  await card.getByRole("combobox", { name: "Status" }).selectOption("interviewing");
  await card.getByRole("textbox", { name: "Round" }).fill("Phone screen");
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.locator('[data-pipeline-column="interviewing"]').locator("[data-pipeline-job]").filter({ hasText: "Pipeline Test Co" })).toBeVisible();

  // Outcomes by tier at application time.
  await expect(page.getByRole("heading", { name: "What your outcomes say" })).toBeVisible();
  await expect(page.locator("[data-tier-outcome]").first().getByText("1 (100%)")).toBeVisible();

  // The job's history lists every step with its details.
  await page.goto(jobUrl);
  await page.getByRole("tab", { name: "History" }).click();
  await expect(page.getByText("New → Shortlisted")).toBeVisible();
  await expect(page.getByText("Shortlisted → Applied")).toBeVisible();
  await expect(page.getByText("Referral")).toBeVisible();
  await expect(page.getByText("Applied → Interviewing")).toBeVisible();
  await expect(page.getByText("Phone screen")).toBeVisible();
});
