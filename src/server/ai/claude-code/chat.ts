import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type Anthropic from "@anthropic-ai/sdk";
import type { AiTask } from "@/shared/ai-settings";
import type { ChatMessageRow, ConversationRow } from "../../db/schema";
import { AiError } from "../errors";
import type { AiContext } from "../client";
import { runClaudeCode, type CliEvent } from "./cli";
import { cliBlocks, systemText } from "./messages";
import { cliToolNote, cliWebTools } from "./agent";
import { isRefusal, logCliUsage } from "./structured";
import { MCP_PREFIX, mcpServersFor, openMcpRun, type McpTool } from "./mcp-runs";

type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type Block = Record<string, unknown> & { type: string };

/** What the chat harness hands over for one turn on the subscription connection. */
export interface CliChatTurn {
  ctx: AiContext;
  conversation: ConversationRow;
  task: AiTask;
  /** The thread's opening context (profile, posting): sent on the first turn only. */
  context: ContentBlockParam[] | null;
  /** This turn's user message (context updates, then the user's text). */
  user: ContentBlockParam[];
  emit(event: { type: "text"; delta: string } | { type: "progress"; text: string } | { type: "tool"; name: string; detail: string | null }): void;
  insertRow(row: { role: "user" | "assistant"; kind: string; content: unknown; stopReason?: string | null; servedModel?: string | null }): ChatMessageRow;
  runTool(block: { id: string; name: string; input: unknown }, messageId: number): Promise<ToolResult>;
}

const WEB_NAMES: Record<string, string> = { WebSearch: "web_search", WebFetch: "web_fetch" };

/** Claude Code's tool names → the names the transcript and the rest of Huntloop use. */
export function huntloopToolName(name: string): string {
  return name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : (WEB_NAMES[name] ?? name);
}

function normalizeBlocks(content: Block[]): Block[] {
  return content.map((b) => (b.type === "tool_use" && typeof b.name === "string" ? { ...b, name: huntloopToolName(b.name) } : b));
}

/** The chat's client tools as MCP tools (server web tools become Claude Code's own). */
export function chatMcpTools(tools: unknown[]): McpTool[] {
  return (tools as Array<{ name?: string; description?: string; input_schema?: Record<string, unknown> }>)
    .filter((t) => t.name && t.input_schema)
    .map((t) => ({ name: t.name!, description: t.description ?? "", inputSchema: t.input_schema! }));
}

/**
 * One chat turn through the user's Claude subscription. Claude Code runs the whole turn (its own
 * tool loop); Huntloop's tools are served over MCP and run through the same handlers as on the API.
 * The thread continues a Claude Code session, forked each turn, so a failed turn leaves the
 * previous session untouched. Returns the new session id.
 */
export async function runCliChatTurn(turn: CliChatTurn): Promise<string> {
  const { ctx, conversation } = turn;
  const tools = conversation.tools as Anthropic.Beta.Messages.BetaToolUnion[];
  const web = cliWebTools(tools);
  const mcpTools = chatMcpTools(tools);

  // Tool calls arrive over MCP without their tool_use id; match them to the assistant blocks seen on stdout.
  const pending: Array<{ id: string; name: string; rowId: number }> = [];
  const seen = new EventEmitter();
  let lastAssistantRow: number | null = null;
  const claim = async (name: string): Promise<{ id: string; rowId: number }> => {
    const take = () => {
      const i = pending.findIndex((p) => p.name === name);
      return i >= 0 ? pending.splice(i, 1)[0] : null;
    };
    let found = take();
    if (!found) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        const check = () => {
          found = take();
          if (found) {
            clearTimeout(timer);
            seen.off("tool", check);
            resolve();
          }
        };
        seen.on("tool", check);
      });
    }
    if (found) return found;
    lastAssistantRow ??= turn.insertRow({ role: "assistant", kind: "assistant", content: [] }).id;
    return { id: `toolu_cli_${randomUUID()}`, rowId: lastAssistantRow };
  };

  const mcp = openMcpRun({
    tools: mcpTools,
    call: async (name, input) => {
      const { id, rowId } = await claim(name);
      const result = await turn.runTool({ id, name, input }, rowId);
      const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content ?? "");
      return { text, isError: result.is_error === true };
    },
  });

  const onEvent = (event: CliEvent) => {
    if (event.parent_tool_use_id) return;
    if (event.type === "stream_event") {
      const e = event.event as { type?: string; delta?: { type?: string; text?: string } } | undefined;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) turn.emit({ type: "text", delta: e.delta.text });
    } else if (event.type === "system" && event.subtype === "task_summary" && typeof event.detail === "string" && event.detail.trim()) {
      turn.emit({ type: "progress", text: event.detail.trim() });
    } else if (event.type === "assistant") {
      const message = event.message as { content?: Block[]; model?: string; stop_reason?: string | null };
      const content = normalizeBlocks(message.content ?? []);
      const row = turn.insertRow({ role: "assistant", kind: "assistant", content, stopReason: message.stop_reason ?? null, servedModel: message.model ?? null });
      lastAssistantRow = row.id;
      for (const block of message.content ?? []) {
        if (block.type !== "tool_use" || typeof block.name !== "string") continue;
        const input = (block.input ?? {}) as { query?: string; url?: string };
        if (block.name.startsWith(MCP_PREFIX)) {
          pending.push({ id: String(block.id), name: block.name.slice(MCP_PREFIX.length), rowId: row.id });
          seen.emit("tool");
        } else if (WEB_NAMES[block.name]) {
          turn.emit({ type: "tool", name: WEB_NAMES[block.name], detail: input.query ?? input.url ?? null });
        }
      }
    } else if (event.type === "user") {
      const content = ((event.message as { content?: unknown } | undefined)?.content ?? []) as Block[];
      const results = Array.isArray(content) ? content.filter((b) => b.type === "tool_result") : [];
      if (results.length) turn.insertRow({ role: "user", kind: "tool_results", content: results });
    }
  };

  const toolNames = mcpTools.map((t) => t.name);
  const note = toolNames.length ? `\n- Huntloop's own tools carry the prefix ${MCP_PREFIX} (for example ${toolNames[0]} is ${MCP_PREFIX}${toolNames[0]}).` : "";
  const session = conversation.providerSession ? ({ mode: "resume", id: conversation.providerSession } as const) : ({ mode: "new", id: randomUUID() } as const);
  try {
    const run = await runClaudeCode({
      model: conversation.model,
      effort: conversation.effort,
      systemPrompt: `${systemText(conversation.system as Parameters<typeof systemText>[0])}${cliToolNote(null, web.tools)}${note}`,
      input: [...(turn.context ? cliBlocks(turn.context) : []), ...cliBlocks(turn.user)],
      tools: web.tools,
      allowedTools: [...web.tools, "mcp__huntloop"],
      disallowedTools: web.disallowed,
      mcpServers: mcpServersFor(mcp.token),
      maxTurns: 12,
      partialMessages: true,
      session,
      signal: ctx.signal,
      onEvent,
    }).catch((error: unknown) => {
      // The CLI can't find the saved session (measured text, Claude Code 2.1.310). Say so instead of
      // quietly starting over: the panel still shows the earlier turns Claude would have forgotten.
      if (session.mode === "resume" && error instanceof AiError && /no conversation found with session id/i.test(`${error.message}\n${String(error.detail ?? "")}`)) {
        throw new AiError("session_expired", "This conversation can't be continued in Claude Code");
      }
      throw error;
    });
    logCliUsage(ctx, turn.task, conversation.model, run);
    if (isRefusal(run)) throw new AiError("refusal", "Claude declined to answer");
    if (!run.sessionId) throw new AiError("api", "Claude Code didn't report its session");
    return run.sessionId;
  } finally {
    mcp.close();
  }
}
