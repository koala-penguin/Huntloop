import type Anthropic from "@anthropic-ai/sdk";
import type { UsageLike } from "../cost";
import type { CliEvent } from "./cli";

type Block = Record<string, unknown> & { type: string };
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;

/** The request's system prompt as plain text (cache markers don't apply to the CLI). */
export function systemText(system: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .map((b) => b.text ?? "")
    .filter(Boolean)
    .join("\n\n");
}

/** Content blocks as the CLI takes them: API-only fields (cache markers, citation switches) removed. */
export function cliBlocks(content: MessageParam["content"]): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (content as unknown as Block[]).map((block) => {
    const rest: Block = { ...block };
    delete rest.cache_control;
    delete rest.citations;
    return rest;
  });
}

function plainText(content: MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return (content as unknown as Block[])
    .map((b) => (b.type === "text" ? String(b.text ?? "") : b.type === "tool_result" ? `[tool result] ${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}` : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * The user message the CLI receives. Huntloop's one-shot calls send a single user message; anything
 * earlier in the request is folded in as a transcript ahead of the last message's own blocks.
 */
export function cliInput(messages: MessageParam[]): Block[] {
  const last = messages.at(-1);
  if (!last) return [];
  const earlier = messages.slice(0, -1);
  const blocks = earlier.length
    ? [
        {
          type: "text",
          text: `<earlier_turns>\n${earlier.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${plainText(m.content)}`).join("\n\n")}\n</earlier_turns>`,
        } as Block,
      ]
    : [];
  return [...blocks, ...cliBlocks(last.content)];
}

/** Token usage of a run from its result event. */
export function runUsage(result: CliEvent): UsageLike {
  const usage = (result.usage ?? {}) as Partial<UsageLike>;
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
    cache_creation: usage.cache_creation ?? null,
    server_tool_use: usage.server_tool_use ?? null,
    iterations: usage.iterations ?? null,
  };
}

/** The model that answered (the CLI may fall back to another one). */
export function servedModel(result: CliEvent, messages: CliEvent[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i].message as { model?: unknown } | undefined;
    if (messages[i].type === "assistant" && typeof message?.model === "string") return message.model;
  }
  const byModel = result.modelUsage && typeof result.modelUsage === "object" ? Object.keys(result.modelUsage) : [];
  return byModel[0] ?? null;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** The tool_result block's content (text), when it came back. */
  resultText: string | null;
  isError: boolean;
  /** Claude Code's structured result for built-in tools (`tool_use_result`). */
  structured: unknown;
}

/** Tool calls of a run, matched with their results. Subagent messages are skipped. */
export function toolCalls(messages: CliEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of messages) {
    if (event.parent_tool_use_id) continue;
    const content = ((event.message as { content?: unknown } | undefined)?.content ?? []) as Block[];
    if (!Array.isArray(content)) continue;
    if (event.type === "assistant") {
      for (const b of content) {
        if (b.type === "tool_use" && typeof b.id === "string") {
          calls.set(b.id, { id: b.id, name: String(b.name), input: (b.input ?? {}) as Record<string, unknown>, resultText: null, isError: false, structured: null });
        }
      }
    } else {
      const results = content.filter((b) => b.type === "tool_result");
      for (const b of results) {
        const call = calls.get(String(b.tool_use_id));
        if (!call) continue;
        call.resultText = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? (b.content as Block[]).map((c) => String(c.text ?? "")).join("\n") : null;
        call.isError = b.is_error === true;
        if (results.length === 1) call.structured = event.tool_use_result ?? null;
      }
    }
  }
  return [...calls.values()];
}
