import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The CV builder end to end in demo mode: forms, the interviewer's chats (answers recorded word for
 * word), resume after a reload, editing an answer, ticking a skill, Generate, the flag card, download.
 * It replaces the profile the other specs use, so it runs last (its own project, after cleanup).
 */

async function answer(page: Page, text: string, next: RegExp | string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-role="user"]').filter({ hasText: text })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-role="assistant"]').getByText(next).last()).toBeVisible({ timeout: 30_000 });
}

test("build a profile and base CV by interview", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/profile");
  // After the other specs there is a profile (the link is on its CV tab); on its own, the empty state shows it.
  const cvTab = page.getByRole("tab", { name: "CV", exact: true });
  const hadProfile = (await cvTab.count()) > 0;
  if (hadProfile) await cvTab.click();
  await page.getByRole("link", { name: "Build by interview" }).click();

  // Stage 0: Full depth (the default), Australia.
  await expect(page.getByRole("heading", { name: "Before we start" })).toBeVisible();
  await expect(page.getByLabel("Full")).toBeChecked();
  await page.getByRole("combobox", { name: "Where you want to work" }).selectOption("AU");
  await page.getByRole("button", { name: "Start the interview" }).click();

  // Stage 1: the target job.
  await expect(page.getByRole("heading", { name: "The job you're after" })).toBeVisible();
  await page.getByRole("textbox", { name: "Job titles" }).fill("Senior Frontend Engineer");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Your right to work there" }).selectOption("au_citizen");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Stage 2: the current role, then a short chat about it.
  await expect(page.getByRole("heading", { name: "Where you are now" })).toBeVisible();
  await page.getByRole("textbox", { name: "Current job title" }).fill("Senior Frontend Engineer");
  await page.getByRole("textbox", { name: "Employer" }).fill("Harbour Payments");
  await page.getByRole("textbox", { name: "Started" }).fill("2021-03");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Describe a normal week in your current (or most recent) role.")).toBeVisible();
  await answer(page, "Planning sprints with product and reviewing pull requests every day.", /Who do you work with/);
  await answer(page, "I report to the Head of Engineering and 3 engineers report to me.", /most proud of/);
  await page.getByRole("button", { name: "That's all" }).click();
  await expect(page.getByText("This part is done.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // Stage 3: the current role is already there; add an older one.
  await expect(page.getByRole("heading", { name: "Your roles" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Job title (role 1)" })).toHaveValue("Senior Frontend Engineer");
  await page.getByRole("button", { name: "Add a role" }).click();
  await page.getByRole("textbox", { name: "Job title (role 2)" }).fill("Frontend Engineer");
  await page.getByRole("textbox", { name: "Employer (role 2)" }).fill("Koala Commerce");
  await page.getByRole("textbox", { name: "Started (role 2)" }).fill("2018-01");
  await page.getByRole("textbox", { name: "Ended (role 2)" }).fill("2021-02");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Stage 4: role 1 in depth.
  await expect(page.getByText(/Let's talk about your role as Senior Frontend Engineer at Harbour Payments/)).toBeVisible();
  await answer(page, "I led a team of 5 engineers on the merchant dashboard.", /accountable for/);
  await answer(page, "I owned the frontend architecture and the code review process.", /achievement you're proud of/);

  // Closing the tab and coming back lands on the same step, with the conversation so far.
  await page.reload();
  await expect(page.getByRole("button", { name: "Each role in depth" })).toHaveAttribute("aria-current", "step");
  await expect(page.locator('[data-role="user"]').filter({ hasText: "I led a team of 5 engineers on the merchant dashboard." })).toBeVisible();
  await expect(page.getByTestId("answer-count")).toHaveText("4 answers recorded");

  await answer(page, "I rebuilt the checkout in React and TypeScript and cut load time by 40%.", /tools, technologies or methods/);
  await page.getByRole("button", { name: "That's all" }).click();
  await expect(page.getByText("This part is done.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Next role" }).click();
  await expect(page.getByText(/Let's talk about your role as Frontend Engineer at Koala Commerce/)).toBeVisible();
  await page.getByRole("button", { name: "Skip this role" }).click();
  await expect(page.getByRole("link", { name: /Frontend Engineer — Koala Commerce/ })).toContainText("Skipped");
  await page.getByRole("button", { name: "Continue" }).click();

  // Stages 6, 9 and 12: forms.
  await expect(page.getByRole("heading", { name: "Education and certifications" })).toBeVisible();
  await page.getByRole("button", { name: "Add education" }).click();
  await page.getByRole("textbox", { name: "Institution (1)" }).fill("Example University");
  await page.getByRole("textbox", { name: "Qualification (1)" }).fill("BSc");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "Languages", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add a language" }).click();
  await page.getByRole("textbox", { name: "Language (1)" }).fill("English");
  await page.getByRole("combobox", { name: "Level (1)" }).selectOption("native");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("heading", { name: "How you appear on the CV" })).toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).fill("Morgan Ellis");
  await page.getByRole("textbox", { name: "Email" }).fill("morgan@example.com");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Review: edit an answer in the drawer, tick a skill the interviewer noted.
  await expect(page.getByRole("heading", { name: "Generate your profile and CV" })).toBeVisible();
  const id = await page.locator("[data-answer]").filter({ hasText: "I owned the frontend architecture and the code review process." }).getAttribute("data-answer");
  const item = page.locator(`[data-answer="${id}"]`);
  await item.getByRole("button", { name: "Edit" }).click();
  await item.getByRole("textbox", { name: "Edit this answer" }).fill("I owned the frontend architecture, code reviews and release process.");
  await item.getByRole("button", { name: "Save answer" }).click();
  await expect(page.locator("[data-answer]").filter({ hasText: "I owned the frontend architecture, code reviews and release process." })).toContainText("Edited");
  await page.getByRole("checkbox", { name: "React" }).check();
  await expect(page.getByRole("checkbox", { name: "React" })).toBeChecked();

  // Generate replaces the profile the earlier specs created, after a confirmation.
  await page.getByRole("button", { name: "Generate my profile and CV" }).click();
  if (hadProfile) await page.getByRole("button", { name: "Replace and generate" }).click();
  await expect(page.getByRole("heading", { name: /Base CV — version 1/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "Download Word (.docx)" })).toBeDisabled();

  // One line couldn't be traced to the answers; removing it unlocks the download.
  const flagged = page.locator("[data-flagged-line]");
  await expect(flagged).toHaveCount(1);
  await flagged.getByRole("button", { name: "Remove" }).click();
  await expect(flagged).toHaveCount(0, { timeout: 30_000 });
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download Word (.docx)" }).click();
  expect((await download).suggestedFilename()).toBe("Morgan-Ellis-CV.docx");

  // The profile now carries the Career record.
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Career record" })).toBeVisible();
});
