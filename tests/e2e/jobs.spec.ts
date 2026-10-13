import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { expect, test } from "./fixtures";

const POSTING = fs.readFileSync(path.join(__dirname, "../fixtures/postings/screenshot-posting.txt"), "utf8");
const NOISY_PASTE = `Home  Jobs  Companies  Sign in\nCookie settings — we use cookies to improve your experience.\n\n${POSTING}\n\nSimilar jobs\nFrontend Developer — Acme — Melbourne`;

async function screenshot(): Promise<Buffer> {
  return sharp({ create: { width: 900, height: 1300, channels: 3, background: "#ffffff" } })
    .png()
    .toBuffer();
}

async function addPastedJob(page: import("@playwright/test").Page, text: string) {
  await page.goto("/jobs");
  await page.getByRole("textbox", { name: "Job link or posting text" }).fill(text);
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page).toHaveURL(/\/jobs\/\d+$/);
  // Analysis runs in the background; the page refreshes into the report.
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 30_000 });
}

test("pasted posting → Interview Chance report → answer a question", async ({ page }) => {
  await addPastedJob(page, NOISY_PASTE);
  await expect(page.getByRole("heading", { name: "Senior Frontend Engineer" })).toBeVisible();
  await expect(page.locator("[data-tier]").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Can they hire you?" })).toBeVisible();
  await expect(page.locator('[data-gate="work_rights"]')).toHaveAttribute("data-status", "pass");
  await expect(page.getByRole("heading", { name: "Requirement by requirement" })).toBeVisible();
  await expect(page.getByText("“Strong React and TypeScript skills”").or(page.getByText("Strong React and TypeScript skills"))).toBeVisible();

  // A requirement the CV doesn't show → answer the Yes/No question; the tier is recomputed in code.
  const row = page.locator('li[data-requirement][data-status="unknown"]').first();
  const id = await row.getAttribute("data-requirement");
  await row.getByRole("button", { name: "Yes" }).click();
  await expect(page.locator(`li[data-requirement="${id}"]`)).toHaveAttribute("data-status", "met");
  await expect(page.locator(`li[data-requirement="${id}"]`).getByText("You said yes.")).toBeVisible();

  // The posting tab shows the cleaned-up posting at a glance.
  await page.getByRole("tab", { name: "Posting" }).click();
  await expect(page.getByRole("heading", { name: "Posting at a glance" })).toBeVisible();
  await expect(page.getByText("No visa sponsorship")).toBeVisible();

  await page.goto("/jobs");
  await expect(page.getByRole("link", { name: /Senior Frontend Engineer/ }).first()).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Your best bets" })).toBeVisible();
  await expect(page.getByRole("link", { name: /Senior Frontend Engineer/ }).first()).toBeVisible();
});

test("three screenshots → one job with an editable transcription", async ({ page }) => {
  await page.goto("/jobs");
  const files = await Promise.all([1, 2, 3].map(async (n) => ({ name: `posting-${n}.png`, mimeType: "image/png", buffer: await screenshot() })));
  await page.getByLabel("Add screenshots or PDF").setInputFiles(files);
  await expect(page.getByRole("list", { name: "Files to add" }).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("This looks like a job you've already added:")).toBeVisible();

  await page.getByRole("tab", { name: "Posting" }).click();
  await expect(page.getByRole("heading", { name: "Screenshots and files" })).toBeVisible();
  await expect(page.getByRole("img", { name: /posting-\d\.png/ })).toHaveCount(3);
  await expect(page.getByText("Bright Harbour Health is rebuilding its patient booking platform.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit text" })).toBeVisible();
});

test("SEEK link asks for the posting text, then analyses it", async ({ page }) => {
  await page.goto("/jobs");
  await page.getByRole("textbox", { name: "Job link or posting text" }).fill("https://www.seek.com.au/job/81234567?type=standard&ref=search");
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page.getByRole("heading", { name: "Add the posting text" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Turn on SEEK in Settings → Job sources/)).toBeVisible();
  await page.getByRole("textbox", { name: "Posting text or screenshots" }).fill(POSTING);
  await page.getByRole("button", { name: "Read this posting" }).click();
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("link", { name: "Original posting" })).toHaveAttribute("href", "https://www.seek.com.au/job/81234567?type=standard");
});

test("Singapore job → work-rights question → re-tiered", async ({ page }) => {
  await addPastedJob(
    page,
    `Data Engineer — Lion City Logistics, Singapore\nFull time · Hybrid\n\nWhat you'll do\nBuild batch and streaming pipelines for our regional delivery network across Southeast Asia.\n\nRequirements\n• 4+ years of data engineering experience\n• Experience with Python and SQL\n• Experience with Kafka is a plus`,
  );
  const gate = page.locator('[data-gate="work_rights"]');
  await expect(gate).toHaveAttribute("data-status", "unclear");
  await page.getByRole("combobox", { name: "Do you have work rights in Singapore?" }).selectOption("sg_pr");
  await page.getByRole("button", { name: "Save to profile" }).click();
  await expect(gate).toHaveAttribute("data-status", "pass");
});

test("chat about a job: streamed answer, profile-fact card, proceed card", async ({ page }) => {
  await page.goto("/jobs");
  await page.getByRole("link", { name: /Senior Frontend Engineer/ }).first().click();
  await page.getByRole("tab", { name: "Ask AI" }).click();
  await page.getByRole("button", { name: "Am I a good fit for this job?" }).click();
  await expect(page.locator('[data-role="assistant"]').filter({ hasText: "Interview Chance:" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-role="user"]').filter({ hasText: "Am I a good fit for this job?" })).toHaveCount(1);

  const input = page.getByRole("textbox", { name: "Your message" });
  await input.fill("I have run accessibility audits against WCAG 2.2 for two years");
  await input.press("Enter");
  const fact = page.locator('[data-action="profile_fact"]');
  await expect(fact.getByText("Add this to your profile?")).toBeVisible({ timeout: 15_000 });
  await fact.getByRole("button", { name: "Add to profile" }).click();
  await expect(fact.getByText("Added to your profile")).toBeVisible();

  await input.fill("Let's apply for this one");
  await page.getByRole("button", { name: "Send" }).click();
  const proceed = page.locator('[data-action="proceed"]');
  await expect(proceed.getByText("Go ahead with this job?")).toBeVisible({ timeout: 15_000 });
  await proceed.getByRole("button", { name: "Proceed" }).click();
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("applying");

  // The conversation is saved: it's still there after a reload.
  await page.reload();
  await page.getByRole("tab", { name: "Ask AI" }).click();
  await expect(page.locator('[data-role="user"]')).toHaveCount(3);
});

test("employer research: sourced claims, hiring activity, advice", async ({ page }) => {
  await page.goto("/jobs?ineligible=1");
  await page.getByRole("link", { name: /Data Engineer/ }).first().click();
  await page.getByRole("tab", { name: "Employer" }).click();
  await expect(page.getByRole("heading", { name: "Research Lion City Logistics" })).toBeVisible();
  await page.getByRole("button", { name: "Research this employer" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-section="activities"]').getByRole("link", { name: /example\.com · 2026-08-14/ })).toBeVisible();
  await expect(page.getByText(/1 claim was left out/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "What this means for you" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh research" })).toBeVisible();
});

test("the report reads in Korean", async ({ page }) => {
  await page.goto("/jobs");
  await page.getByRole("link", { name: /Senior Frontend Engineer/ }).first().click();
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible();
  await page.context().addCookies([{ name: "NEXT_LOCALE", value: "ko", url: page.url() }]);
  await page.reload();
  await expect(page.getByRole("tab", { name: "인터뷰 가능성" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "요구사항별 분석" })).toBeVisible();
  // Prose is translated once (demo mode marks it) and cached.
  await expect(page.getByText(/^\[ko\] /).first()).toBeVisible({ timeout: 15_000 });
});
