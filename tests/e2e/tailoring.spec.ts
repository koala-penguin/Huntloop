import fs from "node:fs";
import path from "node:path";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import { expect, test } from "./fixtures";

const POSTING = fs.readFileSync(path.join(__dirname, "../fixtures/postings/screenshot-posting.txt"), "utf8");

test("proceed → tailored CV with a flagged line → resolve → download DOCX and PDF; LinkedIn text", async ({ page }) => {
  await page.goto("/jobs");
  await page.getByRole("textbox", { name: "Job link or posting text" }).fill(POSTING);
  await page.getByRole("button", { name: "Add job" }).click();
  await expect(page.getByRole("tab", { name: "Interview Chance" })).toBeVisible({ timeout: 30_000 });

  // Proceeding is the user's click: status → Applying, and the CV tab follows the draft being written.
  await page.getByRole("button", { name: "Proceed & tailor my CV" }).click();
  await expect(page).toHaveURL(/tab=cv/);
  await expect(page.getByRole("combobox", { name: "Status" })).toHaveValue("applying");
  await expect(page.getByRole("heading", { name: "Tailored CV — version 1" })).toBeVisible({ timeout: 45_000 });

  // The demo draft contains one bullet with numbers that aren't in the CV: downloads wait for the user.
  await expect(page.getByText("1 line needs your check before you can download.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Download Word (.docx)" })).toBeDisabled();
  const flagged = page.locator("[data-flagged-line]").filter({ hasText: "Improved release frequency by 25% across 3 squads." });
  await expect(flagged.getByText("The number 25% isn't in your CV or confirmed facts.")).toBeVisible();
  await expect(page.frameLocator('iframe[title="Preview"]').getByText("Harbour Payments").first()).toBeVisible();
  await flagged.getByRole("button", { name: "Remove" }).click();
  await expect(page.getByText("Every line is traced to your CV or facts you confirmed.")).toBeVisible();

  const docxDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download Word (.docx)" }).click();
  const docx = await docxDownload;
  expect(docx.suggestedFilename()).toMatch(/^Jamie-Park-CV-.*\.docx$/);
  const { value: docxText } = await mammoth.extractRawText({ path: await docx.path() });
  expect(docxText).toContain("Harbour Payments");
  expect(docxText).not.toContain("25%");

  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download PDF" }).click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toMatch(/\.pdf$/);
  const { text: pdfText } = await extractText(new Uint8Array(fs.readFileSync(await pdf.path())), { mergePages: true });
  expect(pdfText).toContain("Harbour Payments");
  expect(pdfText).not.toContain("25%");

  // Ask for a shorter version: a new, re-checked version appears.
  await page.getByRole("textbox", { name: "What should change?" }).fill("Make it shorter");
  await page.getByRole("button", { name: "Write a new version" }).click();
  await expect(page.getByRole("heading", { name: "Tailored CV — version 2" })).toBeVisible({ timeout: 45_000 });
  await expect(page.getByRole("navigation", { name: "Versions:" }).getByRole("link", { name: "v1" })).toBeVisible();

  // LinkedIn profile text for the target roles, with character counters and copy buttons.
  await page.goto("/profile?tab=linkedin");
  await page.getByRole("button", { name: "Write my LinkedIn profile" }).click();
  const headline = page.locator('[data-linkedin-section="headline"]');
  await expect(headline).toBeVisible({ timeout: 45_000 });
  await expect(headline.getByText(/^\d+ \/ 220$/)).toBeVisible();
  await expect(headline.getByRole("button", { name: "Copy Headline" })).toBeEnabled();
  await expect(page.locator('[data-linkedin-section="about"]')).toBeVisible();
});
