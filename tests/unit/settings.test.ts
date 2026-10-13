import { describe, expect, it } from "vitest";
import { AI_TASKS, defaultAiSettings, normalizeAiConfig, normalizeAiSettings, resolveTaskModel } from "@/shared/ai-settings";
import { getAiConfig, getAiSettings, saveAiConfig, saveAiSettings } from "@/server/repo/settings";
import { appSettings } from "@/server/db/schema";
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
    s.tasks.screen = { model: "claude-haiku-5-5", effort: "low", connection: "profile" };
    expect(resolveTaskModel(s, "screen").model).toBe("claude-haiku-5-5");
    expect(resolveTaskModel(s, "assess").model).toBe("claude-opus-5-5");
  });

  it("repairs stored settings that are partial or contain unknown values", () => {
    const s = normalizeAiSettings({ defaultModel: "gpt-9", tasks: { chat: { model: "claude-sonnet-5-5", effort: "high" }, assess: { model: "nope", effort: "x" } } });
    expect(s.defaultModel).toBe("claude-opus-5-5");
    expect(s.tasks.chat).toEqual({ model: "claude-sonnet-5-5", effort: "high", connection: "profile" });
    expect(s.tasks.assess).toEqual(defaultAiSettings().tasks.assess);
  });

  it("persists settings per user and seeds the default from the environment", () => {
    const { db, userId } = testDb();
    expect(getAiSettings(db, userId, "claude-sonnet-5-5").defaultModel).toBe("claude-sonnet-5-5");
    const s = defaultAiSettings();
    s.budget.dailyUsd = 12;
    s.tasks.companyResearch = { model: "claude-fable-5-1", effort: "xhigh", connection: "profile" };
    saveAiSettings(db, userId, s);
    const loaded = getAiSettings(db, userId);
    expect(loaded.budget.dailyUsd).toBe(12);
    expect(loaded.tasks.companyResearch).toEqual({ model: "claude-fable-5-1", effort: "xhigh", connection: "profile" });
  });

  it("turns settings saved before connections existed into both profiles, keeping every choice", () => {
    const legacy = { defaultModel: "claude-sonnet-5-5", tasks: { screen: { model: "claude-haiku-5-5", effort: "low" } }, budget: { dailyUsd: 3, monthlyUsd: 40, warnAtPercent: 70 } };
    const config = normalizeAiConfig(legacy, "claude-opus-5-5", "subscription");
    expect(config.active).toBe("subscription");
    for (const connection of ["api", "subscription"] as const) {
      const profile = config.profiles[connection];
      expect(profile.connection).toBe(connection);
      expect(profile.defaultModel).toBe("claude-sonnet-5-5");
      expect(profile.tasks.screen).toEqual({ model: "claude-haiku-5-5", effort: "low", connection: "profile" });
      expect(profile.budget).toEqual({ dailyUsd: 3, monthlyUsd: 40, warnAtPercent: 70 });
    }
  });

  it("reads a legacy row from the database and saves each profile separately", () => {
    const { db, userId } = testDb();
    db.insert(appSettings).values({ userId, key: "ai", value: { defaultModel: "claude-fable-5-1" }, updatedAt: new Date() }).run();
    expect(getAiSettings(db, userId, undefined, "api")).toMatchObject({ connection: "api", defaultModel: "claude-fable-5-1" });

    const subscription = { ...getAiConfig(db, userId).profiles.subscription, defaultModel: "claude-haiku-5-5" as const };
    saveAiSettings(db, userId, subscription);
    const config = getAiConfig(db, userId);
    expect(config.profiles.api.defaultModel).toBe("claude-fable-5-1");
    expect(config.profiles.subscription.defaultModel).toBe("claude-haiku-5-5");

    saveAiConfig(db, userId, { ...config, active: "subscription" });
    expect(getAiSettings(db, userId, undefined, "api")).toMatchObject({ connection: "subscription", defaultModel: "claude-haiku-5-5" });
  });

  it("lets a task use the other connection", () => {
    const s = defaultAiSettings(undefined, "subscription");
    s.tasks.screen = { model: "claude-haiku-5-5", effort: "low", connection: "api" };
    expect(resolveTaskModel(s, "screen")).toEqual({ connection: "api", model: "claude-haiku-5-5", effort: "low" });
    expect(resolveTaskModel(s, "chat").connection).toBe("subscription");
  });
});
