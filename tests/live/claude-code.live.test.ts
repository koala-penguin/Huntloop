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

describe("live: coach chat on the subscription, with Huntloop's tools over MCP", () => {
  it("calls a Huntloop tool from a real `claude -p` turn", async () => {
    const http = await import("node:http");
    const { POST, GET, DELETE } = await import("@/app/api/claude-code/mcp/route");
    const { createCoachConversation } = await import("@/server/ai/chat/coach");
    const { runChatTurn } = await import("@/server/ai/chat/harness");
    // A stand-in for the Next server: forwards to the MCP route handler.
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const handler = req.method === "GET" ? GET : req.method === "DELETE" ? DELETE : POST;
      const response = await handler(
        new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: chunks.length ? Buffer.concat(chunks) : undefined }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    process.env.HUNTLOOP_ORIGIN = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const c = ctx();
      const conversation = createCoachConversation(c);
      const events: Array<{ type: string; name?: string; delta?: string; code?: string; message?: string }> = [];
      await runChatTurn(c, conversation.id, "Use your list_jobs tool once, then tell me in one short sentence how many jobs I have.", (e) => events.push(e as never));
      const error = events.find((e) => e.type === "error");
      expect(error, JSON.stringify(error)).toBeUndefined();
      expect(events).toContainEqual(expect.objectContaining({ type: "tool", name: "list_jobs" }));
      expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(0);
    } finally {
      server.close();
      delete process.env.HUNTLOOP_ORIGIN;
    }
  });
});
