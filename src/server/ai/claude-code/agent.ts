import type Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import type { AiTask } from "@/shared/ai-settings";
import { AiError } from "../errors";
import type { AiContext, ResolvedCall } from "../client";
import type { SeenSource, SubmitLoopOptions, SubmitLoopResult } from "../agent-loop";
import { runClaudeCode, type CliEvent } from "./cli";
import { cliInput, toolCalls } from "./messages";
import { cliJsonSchema, isRefusal, logCliUsage } from "./structured";

type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

/** Which of the API's server web tools a request uses, mapped to Claude Code's built-in tools. */
export function cliWebTools(tools: ToolUnion[]): { tools: string[]; disallowed: string[] } {
  const named = tools as Array<{ name?: string; blocked_domains?: string[] }>;
  const search = named.some((t) => t.name === "web_search");
  const fetch = named.some((t) => t.name === "web_fetch");
  const blocked = [...new Set(named.flatMap((t) => t.blocked_domains ?? []))];
  return {
    tools: [...(search ? ["WebSearch"] : []), ...(fetch ? ["WebFetch"] : [])],
    disallowed: fetch ? blocked.map((domain) => `WebFetch(domain:${domain})`) : [],
  };
}

/** Prompts name the API's tools; this tells Claude what they are called here. */
export function cliToolNote(submitName: string | null, tools: string[]): string {
  const lines = [
    tools.includes("WebSearch") ? "- web_search is the WebSearch tool." : null,
    tools.includes("WebFetch") ? "- web_fetch is the WebFetch tool." : null,
    submitName ? `- To call ${submitName}, call the StructuredOutput tool with the same fields. Do it once, when you are done.` : null,
  ].filter(Boolean);
  return lines.length ? `\n\nTool names in this environment:\n${lines.join("\n")}` : "";
}

function linksFromText(text: string): Array<{ url: string; title: string | null }> {
  const match = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/.exec(text);
  if (match) {
    try {
      return (JSON.parse(match[1]) as Array<{ url?: unknown; title?: unknown }>)
        .filter((l) => typeof l.url === "string")
        .map((l) => ({ url: l.url as string, title: typeof l.title === "string" ? l.title : null }));
    } catch {
      // fall through
    }
  }
  return [...text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)].map((m) => ({ url: m[0], title: null }));
}

/** URLs Claude actually saw in this run: search results and pages it fetched without an error. */
export function cliSources(messages: CliEvent[]): SeenSource[] {
  const out: SeenSource[] = [];
  for (const call of toolCalls(messages)) {
    if (call.isError) continue;
    if (call.name === "WebSearch") {
      const structured = call.structured as { results?: unknown[] } | null;
      if (structured && Array.isArray(structured.results)) {
        for (const entry of structured.results) {
          const links = (entry as { content?: unknown } | null)?.content;
          if (!Array.isArray(links)) continue;
          for (const link of links as Array<{ url?: unknown; title?: unknown }>) {
            if (typeof link.url === "string") out.push({ url: link.url, title: typeof link.title === "string" ? link.title : null, pageAge: null });
          }
        }
      } else if (call.resultText) {
        for (const link of linksFromText(call.resultText)) out.push({ ...link, pageAge: null });
      }
    } else if (call.name === "WebFetch") {
      const structured = call.structured as { url?: unknown; code?: unknown } | string | null;
      if (typeof structured === "string" && /^error\b/i.test(structured)) continue;
      if (structured && typeof structured === "object" && typeof structured.code === "number" && structured.code >= 400) continue;
      const url = structured && typeof structured === "object" && typeof structured.url === "string" ? structured.url : typeof call.input.url === "string" ? call.input.url : null;
      if (url) out.push({ url, title: null, pageAge: null });
    }
  }
  return out;
}

/** `runSubmitLoop` through the user's Claude subscription: Claude Code's web tools, the submit schema as structured output. */
export async function runSubmitLoopViaCli<S extends z.ZodType>(ctx: AiContext, task: AiTask, options: SubmitLoopOptions<S>, call: Pick<ResolvedCall, "model" | "effort">): Promise<SubmitLoopResult<z.infer<S>>> {
  const web = cliWebTools(options.tools);
  const run = await runClaudeCode({
    model: call.model,
    effort: call.effort,
    systemPrompt: `${options.system}${cliToolNote(options.submit.name, web.tools)}`,
    input: cliInput(options.messages),
    tools: web.tools,
    allowedTools: web.tools,
    disallowedTools: web.disallowed,
    jsonSchema: cliJsonSchema(options.submit.schema),
    maxTurns: Math.max(12, (options.maxSteps ?? 8) * 3),
    signal: ctx.signal,
    onEvent: (event) => {
      if (event.type === "system" && event.subtype === "task_summary" && typeof event.detail === "string" && event.detail.trim()) options.onProgress?.(event.detail.trim());
    },
  });
  logCliUsage(ctx, task, call.model, run);
  if (isRefusal(run)) throw new AiError("refusal", "Claude declined this request");
  const parsed = options.submit.schema.safeParse(run.result.structured_output);
  if (!parsed.success) throw new AiError("invalid_output", "The AI's result didn't match the expected format", parsed.error.issues);
  return { data: parsed.data as z.infer<S>, sources: cliSources(run.messages), model: call.model };
}
