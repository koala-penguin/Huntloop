import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { callStructured } from "@/server/ai/client";
import { getClaudeCodeStatus } from "@/server/ai/claude-code/status";
import { searchFiltersSchema } from "@/shared/schemas/search";
import { usageLog } from "@/server/db/schema";
import { defaultAiSettings } from "@/shared/ai-settings";
import { testDb } from "../helpers/db";

/** Runs real `claude -p` calls on the signed-in Claude subscription (small: Haiku, low effort). */
beforeAll(async () => {
  delete process.env.HUNTLOOP_AI;
  delete process.env.HUNTLOOP_CLAUDE_PATH;
  process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-live-"));
  const status = await getClaudeCodeStatus({ refresh: true });
  if (!status.loggedIn) throw new Error("Claude Code isn't signed in; run `claude auth login` first.");
});

function ctx() {
  const { db, userId } = testDb();
  const settings = defaultAiSettings("claude-haiku-5-5", "subscription");
  return { db, userId, settings };
}

describe("live: Claude subscription via Claude Code", () => {
  it("answers a structured task", async () => {
    const c = ctx();
    const result = await callStructured(c, "parseSearch", {
      schema: searchFiltersSchema,
      system: "Turn the job search request into filters.",
      messages: [{ role: "user", content: "senior frontend jobs in Sydney, hybrid, posted this week" }],
    });
    expect(JSON.stringify(result.data).toLowerCase()).toContain("sydney");
    expect(c.db.select().from(usageLog).all()[0]).toMatchObject({ via: "claude_code", simulated: false });
  });
});
