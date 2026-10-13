import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AiTask } from "@/shared/ai-settings";
import { logUsage } from "../../repo/usage";
import { computeCost, type UsageCost } from "../cost";
import { AiError } from "../errors";
import type { AiContext, ResolvedCall, StructuredRequest, StructuredResult } from "../client";
import { runClaudeCode, type CliEvent, type CliRunOptions, type CliRunResult } from "./cli";
import { cliInput, runUsage, servedModel, systemText, toolCalls } from "./messages";

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;

/** JSON Schema for `--json-schema` from a Zod schema. */
export function cliJsonSchema(schema: z.ZodType): object {
  return Object.fromEntries(Object.entries(z.toJSONSchema(schema)).filter(([key]) => key !== "$schema"));
}

/** Logs a finished run like an API call (via "claude_code": the cost is what it would have been on the API). */
export function logCliUsage(ctx: AiContext, task: AiTask, model: string, run: CliRunResult): UsageCost {
  const usage = runUsage(run.result);
  // Claude Code's WebSearch runs as its own request and isn't in the run's usage; count the calls.
  const searches = toolCalls(run.messages).filter((c) => c.name === "WebSearch" && !c.isError).length;
  if (searches > (usage.server_tool_use?.web_search_requests ?? 0)) usage.server_tool_use = { ...(usage.server_tool_use ?? {}), web_search_requests: searches };
  const cost = computeCost(model, usage);
  logUsage(ctx.db, { ...cost, userId: ctx.userId, task, model, servedModel: servedModel(run.result, run.messages), simulated: false, via: "claude_code" });
  return cost;
}

/** A stand-in for the API message, for callers that read `stop_reason` or `usage`. */
export function syntheticMessage(model: string, run: CliRunResult): BetaMessage {
  const result = run.result as CliEvent & { result?: unknown; stop_reason?: unknown };
  return {
    id: String(result.uuid ?? "cli"),
    type: "message",
    role: "assistant",
    model: servedModel(run.result, run.messages) ?? model,
    content: typeof result.result === "string" && result.result ? [{ type: "text", text: result.result, citations: null }] : [],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: runUsage(run.result),
  } as unknown as BetaMessage;
}

export function isRefusal(run: CliRunResult): boolean {
  if (run.result.stop_reason === "refusal") return true;
  return run.messages.some((m) => m.type === "assistant" && (m.message as { stop_reason?: unknown } | undefined)?.stop_reason === "refusal");
}

/** A structured-output task through the user's Claude subscription. */
export async function callStructuredViaCli<S extends z.ZodType>(
  ctx: AiContext,
  task: AiTask,
  request: StructuredRequest<S>,
  call: Pick<ResolvedCall, "model" | "effort">,
  extra: Partial<CliRunOptions> = {},
): Promise<StructuredResult<z.infer<S>>> {
  const run = await runClaudeCode({
    model: call.model,
    effort: call.effort,
    systemPrompt: systemText(request.system as Parameters<typeof systemText>[0]),
    input: cliInput(request.messages),
    tools: [],
    jsonSchema: cliJsonSchema(request.schema),
    maxTurns: 4,
    signal: ctx.signal,
    ...extra,
  });
  const cost = logCliUsage(ctx, task, call.model, run);
  if (isRefusal(run)) throw new AiError("refusal", "The AI declined this request");
  const parsed = request.schema.safeParse(run.result.structured_output);
  if (!parsed.success) throw new AiError("invalid_output", "The AI response did not match the expected format", parsed.error.issues);
  return { message: syntheticMessage(call.model, run), model: call.model, effort: call.effort, cost, data: parsed.data as z.infer<S> };
}
