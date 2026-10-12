import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { resolveTaskModel, type AiTask } from "@/shared/ai-settings";
import { AiError, callModel, settingsFor, type AiContext } from "./client";

type Block = Record<string, unknown> & { type: string };
type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

/** Strict client tool whose input schema is generated from a Zod schema. */
export function submitTool(name: string, description: string, schema: z.ZodType): Anthropic.Beta.Messages.BetaTool {
  const input = Object.fromEntries(Object.entries(z.toJSONSchema(schema)).filter(([key]) => key !== "$schema"));
  return { name, description, strict: true, input_schema: input } as unknown as Anthropic.Beta.Messages.BetaTool;
}

/** Comparable form of a URL: no fragment or tracking parameters, no "www.", no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|gclid|fbclid)/i.test(key)) url.searchParams.delete(key);
    return `${url.protocol}//${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
  } catch {
    return null;
  }
}

export interface SeenSource {
  url: string;
  title: string | null;
  pageAge: string | null;
}

/** URLs Claude actually saw: web search results and fetched pages. */
export function seenSources(content: Block[]): SeenSource[] {
  const out: SeenSource[] = [];
  for (const block of content) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content as Block[]) {
        if (r.type === "web_search_result" && typeof r.url === "string") out.push({ url: r.url, title: (r.title as string) ?? null, pageAge: (r.page_age as string) ?? null });
      }
    } else if (block.type === "web_fetch_tool_result" && block.content && typeof block.content === "object") {
      const r = block.content as Block;
      if (r.type === "web_fetch_result" && typeof r.url === "string") {
        const title = ((r.content as Block | undefined)?.title as string | undefined) ?? null;
        out.push({ url: r.url, title, pageAge: (r.retrieved_at as string) ?? null });
      }
    }
  }
  return out;
}

export function sourceSet(sources: Array<{ url: string }>): Set<string> {
  return new Set(sources.map((s) => normalizeUrl(s.url)).filter((u): u is string => !!u));
}

export interface SubmitLoopOptions<S extends z.ZodType> {
  system: string;
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  /** Server tools (web search/fetch); the submit tool is added automatically. */
  tools: ToolUnion[];
  submit: { name: string; description: string; schema: S };
  maxSteps?: number;
  maxTokens?: number;
  onProgress?: (note: string) => void;
}

export interface SubmitLoopResult<T> {
  data: T;
  sources: SeenSource[];
  model: string;
}

/**
 * Agent pattern: Claude works with server-side tools (search, fetch) and finishes by calling a
 * strict submit tool. No forced tool_choice; if Claude stops without submitting it is asked once.
 * pause_turn continues the same turn. Only URLs in `sources` were really seen.
 */
export async function runSubmitLoop<S extends z.ZodType>(ctx: AiContext, task: AiTask, options: SubmitLoopOptions<S>): Promise<SubmitLoopResult<z.infer<S>>> {
  const { model, effort } = resolveTaskModel(settingsFor(ctx), task);
  const tools = [...options.tools, submitTool(options.submit.name, options.submit.description, options.submit.schema)];
  const messages = [...options.messages];
  const seen: Block[] = [];
  let nudged = false;

  for (let step = 0; step < (options.maxSteps ?? 8); step++) {
    const { message } = await callModel(ctx, task, { system: options.system, messages, tools }, {
      model,
      effort,
      maxTokens: options.maxTokens ?? 32_000,
      progressUpdates: true,
      enforceBudget: true,
      onEvent: (event) => {
        if (event.type === "content_block_delta" && event.delta.type === "thinking_delta" && event.delta.thinking.trim()) options.onProgress?.(event.delta.thinking.trim());
      },
    });
    if (message.stop_reason === "refusal") throw new AiError("refusal", "Claude declined this request");
    seen.push(...(message.content as unknown as Block[]));
    messages.push({ role: "assistant", content: message.content as Anthropic.Beta.Messages.BetaContentBlockParam[] });

    const call = message.content.find((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use" && b.name === options.submit.name);
    if (call) {
      const parsed = options.submit.schema.safeParse(call.input);
      if (!parsed.success) throw new AiError("invalid_output", "The AI's result didn't match the expected format", parsed.error.issues);
      return { data: parsed.data as z.infer<S>, sources: seenSources(seen), model };
    }
    if (message.stop_reason === "pause_turn") continue;
    if (message.stop_reason === "tool_use") {
      // Some other client tool was called; answer it so the conversation stays valid, then continue.
      const results = message.content
        .filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ type: "tool_result" as const, tool_use_id: b.id, content: `Unknown tool. Use ${options.submit.name} to submit.`, is_error: true }));
      messages.push({ role: "user", content: results });
      continue;
    }
    if (nudged) break;
    nudged = true;
    messages.push({ role: "user", content: [{ type: "text", text: `Please submit your findings now with ${options.submit.name}.` }] });
  }
  throw new AiError("invalid_output", `Claude finished without calling ${options.submit.name}`);
}
