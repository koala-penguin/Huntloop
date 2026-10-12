import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { MODEL_IDS, type Effort, type ModelId } from "@/shared/models";
import { resolveTaskModel, type AiSettings, type AiTask } from "@/shared/ai-settings";
import { aiMode, envDefaultModel } from "../config/env";
import type { Db } from "../db/database";
import { getAiSettings } from "../repo/settings";
import { logUsage, spendSummary } from "../repo/usage";
import { computeCost, type UsageCost } from "./cost";
import { buildBaseParams, type RequestOptions } from "./request";
import { createFakeFetch } from "./fake/transport";
import "./fake/generators";

type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type StreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;

export type AiErrorCode = "refusal" | "max_tokens" | "invalid_output" | "budget" | "api";

export class AiError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "AiError";
  }
}

export interface AiContext {
  db: Db;
  userId: number;
  signal?: AbortSignal;
  /** Settings snapshot; read from the database when omitted. */
  settings?: AiSettings;
}

interface ClientState {
  client?: Anthropic;
  mode?: "live" | "fake";
  /** Models whose optional beta features were rejected once; they're sent without them from then on. */
  degraded: Set<string>;
}

const state = ((globalThis as unknown as { huntloopAi?: ClientState }).huntloopAi ??= { degraded: new Set() });

export function currentAiMode(): "live" | "fake" {
  return aiMode();
}

export function getAnthropic(): Anthropic {
  const mode = aiMode();
  if (!state.client || state.mode !== mode) {
    state.mode = mode;
    state.client =
      mode === "fake"
        ? new Anthropic({
            apiKey: "demo-mode",
            maxRetries: 0,
            fetch: createFakeFetch({ streamDelayMs: process.env.NODE_ENV === "test" ? 0 : 12, models: [...MODEL_IDS] }),
          })
        : new Anthropic();
  }
  return state.client;
}

/** For tests: drop the cached client (e.g. after changing HUNTLOOP_AI). */
export function resetAiClient(): void {
  state.client = undefined;
  state.mode = undefined;
  state.degraded.clear();
}

export function settingsFor(ctx: AiContext): AiSettings {
  return ctx.settings ?? getAiSettings(ctx.db, ctx.userId, envDefaultModel());
}

export interface BudgetStatus {
  todayUsd: number;
  monthUsd: number;
  dailyCapUsd: number;
  monthlyCapUsd: number | null;
  exceeded: boolean;
  warning: boolean;
}

export function budgetStatus(ctx: AiContext): BudgetStatus {
  const { budget } = settingsFor(ctx);
  const spend = spendSummary(ctx.db, ctx.userId);
  const dailyRatio = budget.dailyUsd > 0 ? spend.todayUsd / budget.dailyUsd : 0;
  const monthlyRatio = budget.monthlyUsd ? spend.monthUsd / budget.monthlyUsd : 0;
  const ratio = Math.max(dailyRatio, monthlyRatio);
  return {
    ...spend,
    dailyCapUsd: budget.dailyUsd,
    monthlyCapUsd: budget.monthlyUsd,
    exceeded: ratio >= 1,
    warning: ratio * 100 >= budget.warnAtPercent,
  };
}

export interface CallOptions extends RequestOptions {
  /** Bulk/background work is blocked once the budget cap is reached; interactive calls only warn. */
  enforceBudget?: boolean;
  model?: ModelId;
  effort?: Effort;
  onEvent?: (event: StreamEvent) => void;
}

export type CallRequest = Omit<StreamParams, "model" | "max_tokens" | "thinking" | "output_config" | "betas" | "stream"> & {
  output_config?: Omit<NonNullable<StreamParams["output_config"]>, "effort">;
};

export interface CallResult {
  message: BetaMessage;
  model: ModelId;
  effort: Effort;
  cost: UsageCost;
}

/**
 * One streamed Messages API call with Huntloop's conventions applied. Callers inspect
 * `stop_reason` themselves (chat needs to handle `tool_use` / `pause_turn` / `refusal`).
 */
export async function callModel(ctx: AiContext, task: AiTask, request: CallRequest, options: CallOptions = {}): Promise<CallResult> {
  const settings = settingsFor(ctx);
  const resolved = resolveTaskModel(settings, task);
  const model = options.model ?? resolved.model;
  const effort = options.effort ?? resolved.effort;

  if (options.enforceBudget && budgetStatus({ ...ctx, settings }).exceeded) {
    throw new AiError("budget", "AI budget cap reached");
  }

  const client = getAnthropic();
  const mode = aiMode();
  const send = async (withoutOptionalFeatures: boolean) => {
    const base = buildBaseParams(model, effort, { ...options, withoutOptionalFeatures });
    const { betas, ...rest } = base;
    const params = {
      ...rest,
      ...request,
      output_config: { ...request.output_config, effort },
      ...(betas.length ? { betas } : {}),
    } as StreamParams & { betas?: string[] };
    const stream = client.beta.messages.stream(params, {
      signal: ctx.signal,
      headers: mode === "fake" ? { "x-huntloop-task": task } : undefined,
    });
    if (options.onEvent) {
      for await (const event of stream) options.onEvent(event);
    }
    return (await stream.finalMessage()) as BetaMessage;
  };

  let message: BetaMessage;
  const alreadyDegraded = state.degraded.has(model);
  try {
    message = await send(alreadyDegraded);
  } catch (error) {
    if (error instanceof Anthropic.BadRequestError && !alreadyDegraded) {
      // An optional beta (fallbacks, progress notes, block binding) may not be accepted for this
      // model/account combination. Retry once without them; remember it only if that works.
      console.warn(`[huntloop] ${model} rejected a request with optional features; retrying without them: ${error.message}`);
      message = await send(true);
      state.degraded.add(model);
    } else {
      throw error;
    }
  }

  const cost = computeCost(model, message.usage);
  logUsage(ctx.db, {
    ...cost,
    userId: ctx.userId,
    task,
    model,
    servedModel: message.model ?? null,
    simulated: mode === "fake",
  });
  return { message, model, effort, cost };
}

export interface StructuredRequest<S extends z.ZodType> {
  schema: S;
  system?: CallRequest["system"];
  messages: CallRequest["messages"];
  tools?: CallRequest["tools"];
}

export interface StructuredResult<T> extends CallResult {
  data: T;
}

/**
 * A call whose answer must match a Zod schema (structured outputs). Refusals and truncated or
 * unparseable output raise `AiError`; one retry with more room is made on `max_tokens`.
 */
export async function callStructured<S extends z.ZodType>(
  ctx: AiContext,
  task: AiTask,
  request: StructuredRequest<S>,
  options: CallOptions = {},
): Promise<StructuredResult<z.infer<S>>> {
  const format = betaZodOutputFormat(request.schema);
  let maxTokens = options.maxTokens ?? 32_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: CallResult;
    try {
      result = await callModel(
        ctx,
        task,
        { system: request.system, messages: request.messages, tools: request.tools, output_config: { format } },
        { ...options, maxTokens },
      );
    } catch (error) {
      if (error instanceof Anthropic.AnthropicError && !(error instanceof Anthropic.APIError)) {
        throw new AiError("invalid_output", "The AI response did not match the expected format", error.message);
      }
      throw error;
    }
    const { message } = result;
    if (message.stop_reason === "refusal") {
      throw new AiError("refusal", "The AI declined this request", message.stop_details);
    }
    if (message.stop_reason === "max_tokens") {
      maxTokens = Math.min(maxTokens * 2, 128_000);
      continue;
    }
    const parsed = (message as BetaMessage & { parsed_output?: unknown }).parsed_output;
    if (parsed === null || parsed === undefined) {
      throw new AiError("invalid_output", "The AI response did not match the expected format");
    }
    return { ...result, data: parsed as z.infer<S> };
  }
  throw new AiError("max_tokens", "The AI response was too long even with extra room");
}
