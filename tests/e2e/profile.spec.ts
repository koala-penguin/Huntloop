import path from "node:path";
import { expect, test } from "./fixtures";

const fixture = (name: string) => path.join(__dirname, "../fixtures/cv", name);

test("upload a CV, edit the profile, set preferences", async ({ page }) => {
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "Start with your CV" })).toBeVisible();

  await page.getByLabel("CV file").setInputFiles(fixture("sample-cv-en.docx"));
  await page.getByRole("button", { name: "Read my CV" }).click();

  // Extraction runs as a background task; the page refreshes into the editor when it's done.
  await expect(page.getByRole("tab", { name: "Profile" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveValue("Jamie Park");
  await expect(page.getByText(/years in total/)).toBeVisible();
  await expect(page.locator('input[value="Harbour Payments"]')).toBeVisible();

  // The CV said "Permanent resident of Australia"; switch to the 485 visa and add a fact.
  await page.getByRole("combobox", { name: "Your status" }).first().selectOption("au_485");
  await page.getByRole("textbox", { name: "Add a fact" }).fill("Ran on-call for the payments platform");
  await page.getByRole("button", { name: "Add fact" }).click();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Saved as version 2")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Your status" }).first()).toHaveValue("au_485");
  await expect(page.getByText("Ran on-call for the payments platform")).toBeVisible();

  await page.getByRole("tab", { name: "Job preferences" }).click();
  await page.getByRole("textbox", { name: "Job titles" }).fill("Senior Frontend Engineer");
  await page.keyboard.press("Enter");
  await page.getByLabel("Senior", { exact: true }).check();
  await page.getByRole("combobox", { name: "Cities" }).fill("Sydney");
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Add a country…" }).selectOption("NZ");
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // New Zealand now appears in the work-rights section, and the dashboard shows the profile.
  await page.getByRole("tab", { name: "Profile" }).click();
  await expect(page.getByRole("paragraph").filter({ hasText: "New Zealand" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByText(/Profile version 2/)).toBeVisible();

  await page.context().addCookies([{ name: "NEXT_LOCALE", value: "ko", url: page.url() }]);
  await page.goto("/profile");
  await expect(page.getByRole("heading", { name: "내 프로필" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "희망 조건" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "내 상태" }).first()).toHaveValue("au_485");
});
