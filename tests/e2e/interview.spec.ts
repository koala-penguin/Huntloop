import { expect, test } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * The CV builder end to end in demo mode: every step as a conversation (what was typed lands on a
 * card that is checked and used, with what is saved shown under the chat), the interviewer's story
 * chats (answers recorded word for word, example chips, a cleaner version accepted, a skipped
 * question, a skipped role undone), resume after a reload, the language picker, the guided contact
 * step, editing an answer, ticking a skill, Generate, the flag card, download.
 * It replaces the profile the other specs use, so it runs last (its own project, after cleanup).
 */

async function answer(page: Page, text: string, next: RegExp | string) {
  await page.getByRole("textbox", { name: "Message" }).fill(text);
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.locator('[data-role="user"]').filter({ hasText: text })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-role="assistant"]').getByText(next).last()).toBeVisible({ timeout: 30_000 });
}

/** The card the interviewer made for a step, waiting to be checked. */
const formCard = (page: Page, stage: string) => page.locator(`[data-action="interview_form"][data-stage="${stage}"][data-status="pending"]`);

/** Uses the step's card as it stands and waits for it to be saved. */
async function useCard(page: Page, stage: string) {
  await formCard(page, stage).getByRole("button", { name: "Use this" }).click();
  await expect(page.locator(`[data-action="interview_form"][data-stage="${stage}"][data-status="accepted"]`).last()).toContainText("Saved");
}

test("build a profile and base CV by interview", async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto("/profile");
  // After the other specs there is a profile (the link is on its CV tab); on its own, the empty state shows it.
  const cvTab = page.getByRole("tab", { name: "CV", exact: true });
  const hadProfile = (await cvTab.count()) > 0;
  if (hadProfile) await cvTab.click();
  await page.getByRole("link", { name: "CV-building interview" }).click();

  // Stage 0: Full depth (the default), Australia.
  await expect(page.getByRole("heading", { name: "Before we start" })).toBeVisible();
  await expect(page.getByLabel("Full")).toBeChecked();
  await page.getByRole("combobox", { name: "Where you want to work" }).selectOption("AU");
  await page.getByRole("button", { name: "Start the CV-building interview" }).click();

  // Their situation, in their own words: only what they said is ticked on the card, and they can change it.
  await expect(page.getByRole("heading", { name: "Your situation" })).toBeVisible();
  await expect(page.getByText(/tell me a bit about your situation/)).toBeVisible();
  await answer(page, "I'm changing careers from teaching, and I just graduated from a bootcamp.", /That's what I need here/);
  const situation = formCard(page, "setup");
  await expect(situation.getByRole("checkbox", { name: "Changing careers" })).toBeChecked();
  await expect(situation.getByRole("checkbox", { name: "Recent graduate" })).toBeChecked();
  await expect(situation.getByRole("checkbox", { name: "Senior leader or executive" })).not.toBeChecked();
  await expect(situation.getByRole("checkbox", { name: "I have no CV" })).not.toBeChecked();
  await situation.getByRole("checkbox", { name: "I have no CV" }).check();
  await situation.getByRole("checkbox", { name: "Recent graduate" }).uncheck();
  await useCard(page, "setup");
  await expect(page.locator('[data-onfile="setup"]')).toContainText("Changing careers, I have no CV");
  await expect(page.locator('[data-onfile="setup"]')).toContainText("English · Australia · Full");
  await page.getByRole("button", { name: "Continue" }).click();

  // Stage 1: the target job, as a short chat. What is typed lands on a card; the card is what saves it.
  await expect(page.getByRole("heading", { name: "The job you're after" })).toBeVisible();
  await expect(page.locator('[data-role="assistant"]').first()).toBeVisible();
  // After the other specs the saved search may already hold this title: then ask for another one.
  const onFileTarget = page.locator('[data-onfile="target"]');
  const targetTitle = (await onFileTarget.textContent())?.includes("Senior Frontend Engineer") ? "Lead Frontend Engineer" : "Senior Frontend Engineer";
  await answer(page, targetTitle, /Where do you want to work/);
  const target = formCard(page, "target");
  await expect(target).toContainText(targetTitle);
  await target.getByRole("combobox", { name: "Your right to work there" }).selectOption("au_citizen");
  await useCard(page, "target");
  await expect(onFileTarget).toContainText(targetTitle);
  await page.getByRole("button", { name: "Continue" }).click();

  // Stage 2: what they do now is asked first (no form), then a short chat about it.
  await expect(page.getByText(/What are you doing right now/)).toBeVisible();
  // Examples under the question fill the reply box; nothing is sent until the user sends it.
  const examples = page.locator("[data-suggestion]");
  expect(await examples.count()).toBeGreaterThanOrEqual(3);
  const example = (await examples.first().getAttribute("data-suggestion"))!;
  await examples.first().click();
  await expect(page.getByRole("textbox", { name: "Message" })).toHaveValue(example);
  await expect(page.locator('[data-role="user"]')).toHaveCount(0);
  await answer(page, "I work as Senior Frontend Engineer at Harbour Payments since March 2021", /While you check that card: You're Senior Frontend Engineer at Harbour Payments right now\. What does a normal week look like\?/);
  const current = formCard(page, "current");
  await expect(current.getByRole("textbox", { name: "Current job title" })).toHaveValue("Senior Frontend Engineer");
  await expect(current.getByRole("textbox", { name: "Employer" })).toHaveValue("Harbour Payments");
  await expect(current.getByRole("combobox", { name: "Started: month" })).toHaveValue("03");
  await expect(current.getByRole("textbox", { name: "Started: year" })).toHaveValue("2021");
  await useCard(page, "current");
  await expect(page.locator('[data-onfile="current"]')).toContainText("Senior Frontend Engineer, Harbour Payments");
  // The intake reply is data, not an answer: nothing recorded yet.
  await expect(page.getByTestId("answer-count")).toHaveText("No answers recorded yet");
  await answer(page, "Planning sprints with product and reviewing pull requests every day.", /Who do you work with/);
  await answer(page, "I report to the Head of Engineering and 3 engineers report to me.", /most proud of/);
  // A cleaner version of that answer, kept to the user's own numbers and names.
  const polish = page.locator('[data-action="interview_polish"]').filter({ hasText: "Head of Engineering" });
  await expect(polish.locator("[data-polish-text]")).toHaveText("Report to the Head of Engineering and 3 engineers report to me.");
  await polish.getByRole("button", { name: "Use this" }).click();
  await expect(polish).toContainText("Using this version");
  // Skipping a question moves on to the next one and records nothing.
  await expect(page.getByTestId("answer-count")).toHaveText("2 answers recorded");
  await page.locator('[data-control="skipQuestion"]').click();
  await expect(page.locator('[data-role="assistant"]').getByText(/Why are you looking/).last()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("answer-count")).toHaveText("2 answers recorded");
  await page.getByRole("button", { name: "That's all for this part" }).click();
  await expect(page.getByText("This part is done.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(page.locator("[data-control]")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue" }).click();

  // Stage 3: the current role is already on file; an older one is typed, checked on its card and used.
  await expect(page.getByRole("heading", { name: "Your roles" })).toBeVisible();
  const onFileRoles = page.locator('[data-onfile="roles"]');
  await expect(onFileRoles).toContainText("Senior Frontend Engineer, Harbour Payments");
  await answer(page, "Frontend Engineer at Koala Commerce, 2018-01 to 2021-02", /Any job before that/);
  const rolesCard = page.getByRole("group", { name: "Your roles" });
  await expect(rolesCard.getByRole("textbox", { name: "Job title (role 1)" })).toHaveValue("Frontend Engineer");
  await expect(rolesCard.getByRole("textbox", { name: "Employer (role 1)" })).toHaveValue("Koala Commerce");
  // Dates are a month picker and a year box, each with its own name.
  await expect(rolesCard.getByRole("combobox", { name: "Started (role 1): month" })).toHaveValue("01");
  await expect(rolesCard.getByRole("textbox", { name: "Started (role 1): year" })).toHaveValue("2018");
  await expect(rolesCard.getByRole("combobox", { name: "Ended (role 1): month" })).toHaveValue("02");
  await expect(rolesCard.getByRole("textbox", { name: "Ended (role 1): year" })).toHaveValue("2021");
  await expect(rolesCard.getByRole("checkbox", { name: "I still work here (role 1)" })).not.toBeChecked();
  // Nothing is saved yet, and Continue waits for the card.
  await expect(onFileRoles).not.toContainText("Koala Commerce");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Use or dismiss the card above first." })).toBeVisible();
  // The card and what is on file survive a reload.
  await page.reload();
  await expect(formCard(page, "roles").getByRole("textbox", { name: "Employer (role 1)" })).toHaveValue("Koala Commerce");
  await expect(onFileRoles).toContainText("Senior Frontend Engineer, Harbour Payments");
  await useCard(page, "roles");
  await expect(onFileRoles).toContainText("Frontend Engineer, Koala Commerce · 2018-01 – 2021-02");
  await page.getByRole("button", { name: "Continue" }).click();

  // Stage 4: role 1 in depth.
  await expect(page.getByText(/Let's talk about your time as Senior Frontend Engineer at Harbour Payments/)).toBeVisible();
  await expect(page.locator("[data-suggestion]").first()).toBeVisible();
  await answer(page, "I owned the frontend architecture and the code review process.", /How big was that/);
  await answer(page, "I led a team of 5 engineers on the merchant dashboard.", /proudest/);

  // Closing the tab and coming back lands on the same step, with the conversation so far.
  await page.reload();
  await expect(page.getByRole("button", { name: "Each role in depth" })).toHaveAttribute("aria-current", "step");
  await expect(page.locator('[data-role="user"]').filter({ hasText: "I led a team of 5 engineers on the merchant dashboard." })).toBeVisible();
  await expect(page.getByTestId("answer-count")).toHaveText("4 answers recorded");

  await answer(page, "I rebuilt the checkout in React and TypeScript and cut load time by 40%.", /another result/);
  await page.getByRole("button", { name: "That's all for this part" }).click();
  await expect(page.getByText("This part is done.")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Next role" }).click();
  await expect(page.getByText(/Let's talk about your time as Frontend Engineer at Koala Commerce/)).toBeVisible();
  // Skipping a role can be undone.
  await page.getByRole("button", { name: "Skip this role" }).click();
  const koala = page.getByRole("link", { name: /Frontend Engineer — Koala Commerce/ });
  await expect(koala).toContainText("Skipped");
  await koala.click();
  await expect(page.getByText("You skipped this part. You can still answer below.")).toBeVisible();
  await page.getByRole("button", { name: "Undo skip" }).click();
  await expect(koala).not.toContainText("Skipped");
  await expect(page.locator('[data-control="skipQuestion"]')).toBeVisible();
  await page.getByRole("button", { name: "Skip this role" }).click();
  await expect(koala).toContainText("Skipped");
  await page.getByRole("button", { name: "Continue" }).click();

  // Education: typed, checked on the card, used.
  await expect(page.getByRole("heading", { name: "Education and certifications" })).toBeVisible();
  await answer(page, "BSc at Example University", /That's what I need here/);
  await expect(formCard(page, "education").getByRole("textbox", { name: "Institution (1)" })).toHaveValue("Example University");
  await expect(formCard(page, "education").getByRole("textbox", { name: "Qualification (1)" })).toHaveValue("BSc");
  await useCard(page, "education");
  await page.getByRole("button", { name: "Continue" }).click();

  // Languages: the first comes from the chat; more are added on the card, where the field suggests names as you type.
  await expect(page.getByRole("heading", { name: "Languages", exact: true })).toBeVisible();
  await answer(page, "English native", /That's what I need here/);
  const languages = formCard(page, "languages");
  await expect(languages.getByRole("combobox", { name: "Language (1)" })).toHaveValue("English");
  await expect(languages.getByRole("combobox", { name: "Level (1)" })).toHaveValue("native");
  // With the mouse…
  await languages.getByRole("button", { name: "Add a language" }).click();
  const second = languages.getByRole("combobox", { name: "Language (2)" });
  await second.fill("Kor");
  await expect(second).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("listbox", { name: "Language (2)" })).toBeVisible();
  await page.getByRole("option", { name: "Korean", exact: true }).click();
  await expect(second).toHaveValue("Korean");
  await expect(second).toHaveAttribute("aria-expanded", "false");
  expect(await second.getAttribute("aria-controls")).toBeNull();
  // A level nobody typed has to be picked before the card can be used.
  await languages.getByRole("button", { name: "Use this" }).click();
  await expect(languages.getByRole("alert")).toBeVisible();
  await expect(languages.getByRole("combobox", { name: "Level (2)" })).toHaveAttribute("aria-invalid", "true");
  await languages.getByRole("combobox", { name: "Level (2)" }).selectOption("fluent");
  // …and with the keyboard (Enter picks the suggestion; it never sends the chat).
  await languages.getByRole("button", { name: "Add a language" }).click();
  const third = languages.getByRole("combobox", { name: "Language (3)" });
  await third.fill("Jap");
  await expect(third).toHaveAttribute("aria-expanded", "true");
  await third.press("Escape");
  await expect(third).toHaveAttribute("aria-expanded", "false");
  await third.press("ArrowDown");
  await third.press("Enter");
  await expect(third).toHaveValue("Japanese");
  await languages.getByRole("combobox", { name: "Level (3)" }).selectOption("basic");
  await useCard(page, "languages");
  await expect(page.locator('[data-onfile="languages"]')).toContainText("Korean · Fluent");
  await page.getByRole("button", { name: "Continue" }).click();

  // Contact: asked one thing at a time by Huntloop itself; a malformed email is not taken.
  await expect(page.getByRole("heading", { name: "How you appear on the CV" })).toBeVisible();
  await page.getByRole("textbox", { name: /What name should go at the top/ }).fill("Morgan Ellis");
  await page.keyboard.press("Enter");
  const email = page.getByRole("textbox", { name: /Thanks, Morgan\. Which email should employers reply to/ });
  await email.fill("morgan@");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "That doesn't look like an email address" })).toBeVisible();
  await email.fill("morgan@example.com");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("textbox", { name: /phone number/ })).toBeFocused();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await expect(page.locator('[data-onfile="contact"]')).toContainText("morgan@example.com");
  await page.getByRole("button", { name: "Continue" }).click();

  // Review: edit an answer in the drawer, tick a skill the interviewer noted.
  await expect(page.getByRole("heading", { name: "Generate your profile and CV" })).toBeVisible();
  // The accepted cleaner version is what the record shows, with the original words kept.
  const polished = page.locator("[data-answer]").filter({ hasText: "Report to the Head of Engineering and 3 engineers report to me." });
  await expect(polished).toContainText("Your original words");
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
  await expect(page.getByRole("textbox", { name: "CV text", includeHidden: true })).toHaveValue(/Report to the Head of Engineering and 3 engineers report to me\./);
});
