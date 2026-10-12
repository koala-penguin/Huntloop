import { describe, expect, it } from "vitest";
import { AI_TASKS, defaultAiSettings, normalizeAiSettings, resolveTaskModel } from "@/shared/ai-settings";
import { getAiSettings, saveAiSettings } from "@/server/repo/settings";
import { testDb } from "../helpers/db";

describe("AI settings", () => {
  it("defaults every task to Opus 5.5 with per-task effort", () => {
    const s = defaultAiSettings();
    expect(s.defaultModel).toBe("claude-opus-5-5");
    for (const task of AI_TASKS) expect(resolveTaskModel(s, task).model).toBe("claude-opus-5-5");
    expect(resolveTaskModel(s, "screen").effort).toBe("low");
    expect(resolveTaskModel(s, "tailorCv").effort).toBe("high");
  });

  it("uses a task override instead of the default model", () => {
    const s = defaultAiSettings();
    s.tasks.screen = { model: "claude-haiku-5-5", effort: "low" };
    expect(resolveTaskModel(s, "screen").model).toBe("claude-haiku-5-5");
    expect(resolveTaskModel(s, "assess").model).toBe("claude-opus-5-5");
  });

  it("repairs stored settings that are partial or contain unknown values", () => {
    const s = normalizeAiSettings({ defaultModel: "gpt-9", tasks: { chat: { model: "claude-sonnet-5-5", effort: "high" }, assess: { model: "nope", effort: "x" } } });
    expect(s.defaultModel).toBe("claude-opus-5-5");
    expect(s.tasks.chat).toEqual({ model: "claude-sonnet-5-5", effort: "high" });
    expect(s.tasks.assess).toEqual(defaultAiSettings().tasks.assess);
  });

  it("persists settings per user and seeds the default from the environment", () => {
    const { db, userId } = testDb();
    expect(getAiSettings(db, userId, "claude-sonnet-5-5").defaultModel).toBe("claude-sonnet-5-5");
    const s = defaultAiSettings();
    s.budget.dailyUsd = 12;
    s.tasks.companyResearch = { model: "claude-fable-5-1", effort: "xhigh" };
    saveAiSettings(db, userId, s);
    const loaded = getAiSettings(db, userId);
    expect(loaded.budget.dailyUsd).toBe(12);
    expect(loaded.tasks.companyResearch).toEqual({ model: "claude-fable-5-1", effort: "xhigh" });
  });
});
