import { expect, test } from "./fixtures";

test("change a task model, save, and see it persist; switch the app to Korean", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByText(/Demo mode: AI responses are simulated/)).toBeVisible();

  const screeningModel = page.getByRole("combobox", { name: "Quick screening — Model" });
  await screeningModel.selectOption("claude-haiku-5-5");
  await page.getByRole("combobox", { name: "Quick screening — Effort" }).selectOption("medium");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved").first()).toBeVisible();

  await page.reload();
  await expect(page.getByRole("combobox", { name: "Quick screening — Model" })).toHaveValue("claude-haiku-5-5");
  await expect(page.getByRole("combobox", { name: "Quick screening — Effort" })).toHaveValue("medium");

  await page.getByRole("button", { name: "Check model access" }).click();
  await expect(page.getByText("Demo mode: all models appear available.")).toBeVisible();

  await page.getByLabel("App language").selectOption("ko");
  await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "ko");
  await page.getByRole("link", { name: "대시보드" }).click();
  await expect(page.getByRole("heading", { name: "Huntloop에 오신 것을 환영합니다" })).toBeVisible();
});
