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

test("switch between the API key and the Claude subscription; each keeps its own models", async ({ page }) => {
  await page.goto("/settings");
  const subscriptionCard = page.locator('[data-connection="subscription"]');
  // HUNTLOOP_CLAUDE_PATH points nowhere in tests, so Claude Code reads as not installed.
  await expect(subscriptionCard.getByText("Claude Code not found")).toBeVisible();
  await expect(subscriptionCard.getByText("claude auth login")).toBeVisible();

  await subscriptionCard.getByRole("button", { name: "Use this" }).click();
  await expect(subscriptionCard.getByText("In use")).toBeVisible();
  const sidebarSwitch = page.getByRole("group", { name: "Claude via" }).first();
  await expect(sidebarSwitch.getByRole("button", { name: "Subscription" })).toHaveAttribute("aria-pressed", "true");

  // The form now edits the subscription profile; the API profile keeps its own default model.
  await expect(page.getByRole("button", { name: /Subscription.*\(in use\)/ })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Default model").selectOption("claude-sonnet-5-5");
  await page.getByRole("combobox", { name: "Quick screening — Connection" }).selectOption("api");
  await page.getByRole("button", { name: "Save" }).first().click();
  await expect(page.getByText("Saved").first()).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Default model")).toHaveValue("claude-sonnet-5-5");
  await expect(page.getByRole("combobox", { name: "Quick screening — Connection" })).toHaveValue("api");
  await page.getByRole("group", { name: "Settings for" }).getByRole("button", { name: "API key" }).click();
  await expect(page.getByLabel("Default model")).toHaveValue("claude-opus-5-5");

  // Back to the API key from the sidebar switch.
  await sidebarSwitch.getByRole("button", { name: "API key" }).click();
  await expect(page.locator('[data-connection="api"]').getByText("In use")).toBeVisible();
  await expect(sidebarSwitch.getByRole("button", { name: "API key" })).toHaveAttribute("aria-pressed", "true");
});
