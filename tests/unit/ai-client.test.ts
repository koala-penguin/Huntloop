import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AiError, budgetStatus, callModel, callStructured, resetAiClient } from "@/server/ai/client";
import { registerFakeGenerator } from "@/server/ai/fake/transport";
import { defaultAiSettings } from "@/shared/ai-settings";
import { logUsage, spendSummary } from "@/server/repo/usage";
import { testDb } from "../helpers/db";

afterEach(() => resetAiClient());

describe("AI client in demo mode", () => {
  it("returns schema-checked structured output through the real SDK stream parser", async () => {
    registerFakeGenerator("parseSearch", (req) => ({
      content: [{ type: "text", text: JSON.stringify({ keywords: ["react"], model: req.body.model }) }],
    }));
    const { db, userId } = testDb();
    const result = await callStructured(
      { db, userId },
      "parseSearch",
      { schema: z.object({ keywords: z.array(z.string()), model: z.string() }), messages: [{ role: "user", content: "react jobs" }] },
    );
    expect(result.data).toEqual({ keywords: ["react"], model: "claude-opus-5-5" });
    expect(result.effort).toBe("low");
    // Demo calls are logged but never count as spend.
    expect(spendSummary(db, userId).todayUsd).toBe(0);
  });

  it("uses the model chosen in settings for the task", async () => {
    registerFakeGenerator("translate", (req) => ({ content: [{ type: "text", text: JSON.stringify({ model: req.body.model }) }] }));
    const { db, userId } = testDb();
    const settings = defaultAiSettings();
    settings.tasks.translate = { model: "claude-haiku-5-5", effort: "low" };
    const result = await callStructured({ db, userId, settings }, "translate", {
      schema: z.object({ model: z.string() }),
      messages: [{ role: "user", content: "x" }],
    });
    expect(result.data.model).toBe("claude-haiku-5-5");
  });

  it("raises a refusal error instead of returning partial output", async () => {
    registerFakeGenerator("screen", () => ({ content: [], stop_reason: "refusal" }));
    const { db, userId } = testDb();
    await expect(
      callStructured({ db, userId }, "screen", { schema: z.object({ a: z.string() }), messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ code: "refusal" });
  });

  it("rejects output that does not match the schema", async () => {
    registerFakeGenerator("assess", () => ({ content: [{ type: "text", text: JSON.stringify({ wrong: 1 }) }] }));
    const { db, userId } = testDb();
    await expect(
      callStructured({ db, userId }, "assess", { schema: z.object({ a: z.string() }), messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(AiError);
  });

  it("streams events for chat-style calls", async () => {
    const { db, userId } = testDb();
    const deltas: string[] = [];
    const result = await callModel(
      { db, userId },
      "chat",
      { messages: [{ role: "user", content: "안녕하세요" }] },
      {
        onEvent: (e) => {
          if (e.type === "content_block_delta" && e.delta.type === "text_delta") deltas.push(e.delta.text);
        },
      },
    );
    expect(result.message.stop_reason).toBe("end_turn");
    expect(deltas.join("")).toContain("데모 모드");
  });

  it("blocks budget-enforced work once the daily cap is reached", async () => {
    const { db, userId } = testDb();
    const settings = defaultAiSettings();
    settings.budget.dailyUsd = 1;
    logUsage(db, { userId, task: "assess", model: "claude-opus-5-5", servedModel: null, simulated: false, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, costUsd: 1.5 });
    expect(budgetStatus({ db, userId, settings })).toMatchObject({ exceeded: true, todayUsd: 1.5 });
    await expect(
      callModel({ db, userId, settings }, "chat", { messages: [{ role: "user", content: "x" }] }, { enforceBudget: true }),
    ).rejects.toMatchObject({ code: "budget" });
  });
});
