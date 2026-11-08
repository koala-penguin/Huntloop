import Anthropic from "@anthropic-ai/sdk";
import type { z } from "zod";
import { MODEL_IDS, type Effort, type ModelId } from "@/shared/models";
import { resolveTaskModel, type AiSettings, type AiTask, type Connection } from "@/shared/ai-settings";
import { aiMode, envDefaultModel, readEnv } from "../config/env";
import type { Db } from "../db/database";
import { getAiSettings } from "../repo/settings";
import { logUsage, spendSummary } from "../repo/usage";
import { computeCost, type UsageCost } from "./cost";
import { buildBaseParams, type RequestOptions } from "./request";
import { createFakeFetch } from "./fake/transport";
import { AiError } from "./errors";
import { apiOutputFormat } from "./output-format";
import { cachedClaudeCodeStatus, defaultConnection, getClaudeCodeStatus, type ClaudeCodeStatus } from "./claude-code/status";
import { subscriptionLimitedUntil } from "./claude-code/limits";
import { callStructuredViaCli } from "./claude-code/structured";
import "./fake/generators";

type StreamParams = Anthropic.Beta.Messages.MessageCreateParamsStreaming;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type StreamEvent = Anthropic.Beta.Messages.BetaRawMessageStreamEvent;

export { AiError, type AiErrorCode } from "./errors";

export interface AiContext {
  db: Db;
  userId: number;
  signal?: AbortSignal;
  /** Settings snapshot; read from the database when omitted. */
  settings?: AiSettings;
}

interface ClientState {
  clients: Partial<Record<"live" | "fake", Anthropic>>;
  /** Models whose optional beta features were rejected once; they're sent without them from then on. */
  degraded: Set<string>;
}

const state = ((globalThis as unknown as { huntloopAi?: ClientState }).huntloopAi ??= { clients: {}, degraded: new Set() });
state.clients ??= {};

/**
 * How a call is answered: the Anthropic API ("api"), the user's Claude subscription through the
 * Claude Code CLI ("claude_code"), or the demo simulator ("fake") — only with HUNTLOOP_AI=fake or
 * for the API connection without a key. A subscription whose CLI is missing or signed out is still
 * "claude_code": its calls fail with `cli_missing` / `cli_login` (see `assertSubscriptionReady`)
 * instead of quietly producing demo output.
 */
export type AiMode = "api" | "claude_code" | "fake";

export function modeFor(connection: Connection): AiMode {
  const env = readEnv();
  if (env.HUNTLOOP_AI === "fake") return "fake";
  if (connection === "api") return aiMode(env) === "live" ? "api" : "fake";
  return "claude_code";
}

/** Like `modeFor`, but (for the subscription) checks the CLI first when there's no fresh answer. */
export async function resolveMode(connection: Connection): Promise<AiMode> {
  const env = readEnv().HUNTLOOP_AI;
  // A no-op while a signed-in or a fresh negative status is cached.
  if (connection === "subscription" && env !== "fake" && env !== "claude-code") await getClaudeCodeStatus();
  return modeFor(connection);
}

/** Throws `cli_missing` / `cli_login` unless the Claude Code CLI is installed and signed in. */
export function assertSubscriptionReady(status: ClaudeCodeStatus | null = cachedClaudeCodeStatus()): void {
  // HUNTLOOP_AI=claude-code: assume it's signed in (tests and scripted setups).
  if (readEnv().HUNTLOOP_AI === "claude-code") return;
  if (!status?.found) throw new AiError("cli_missing", "Claude Code isn't installed");
  if (!status.loggedIn) throw new AiError("cli_login", "Claude Code isn't signed in");
}

/** Throws like `assertSubscriptionReady` when any of `tasks` runs on a subscription that isn't ready. */
export async function assertAiReady(ctx: AiContext, tasks: AiTask[]): Promise<void> {
  const settings = settingsFor(ctx);
  for (const task of tasks) {
    const { connection } = resolveTaskModel(settings, task);
    if ((await resolveMode(connection)) === "claude_code") assertSubscriptionReady();
  }
}

/** Whether a call for `task` would be answered by the demo simulator — the key for reusing cached output. */
export async function simulatedFor(ctx: AiContext, task: AiTask): Promise<boolean> {
  return (await resolveMode(resolveTaskModel(settingsFor(ctx), task).connection)) === "fake";
}

/** `simulatedFor` without re-checking the CLI (sync callers and page reads). */
export function simulatedForSync(ctx: AiContext, task: AiTask): boolean {
  return modeFor(resolveTaskModel(settingsFor(ctx), task).connection) === "fake";
}

/** The mode of the active connection (for banners and the settings page). */
export async function currentAiMode(ctx?: AiContext): Promise<AiMode> {
  const connection = ctx ? settingsFor(ctx).connection : "api";
  return resolveMode(connection);
}

export function getAnthropic(mode: "live" | "fake" = aiMode()): Anthropic {
  state.clients[mode] ??=
    mode === "fake"
      ? new Anthropic({
          apiKey: "demo-mode",
          maxRetries: 0,
          fetch: createFakeFetch({ streamDelayMs: process.env.NODE_ENV === "test" ? 0 : 12, models: [...MODEL_IDS] }),
        })
      : new Anthropic();
  return state.clients[mode]!;
}

/** For tests: drop the cached clients (e.g. after changing HUNTLOOP_AI). */
export function resetAiClient(): void {
  state.clients = {};
  state.degraded.clear();
}

export function settingsFor(ctx: AiContext): AiSettings {
  return ctx.settings ?? getAiSettings(ctx.db, ctx.userId, envDefaultModel(), defaultConnection());
}

export interface ResolvedCall {
  settings: AiSettings;
  connection: Connection;
  mode: AiMode;
  model: ModelId;
  effort: Effort;
}

/** Which connection, model and effort a task's call uses; checks the budget or subscription limit for background work. */
export async function resolveCall(ctx: AiContext, task: AiTask, options: Pick<CallOptions, "model" | "effort" | "connection" | "enforceBudget"> = {}): Promise<ResolvedCall> {
  const settings = settingsFor(ctx);
  const resolved = resolveTaskModel(settings, task);
  const connection = options.connection ?? resolved.connection;
  const mode = await resolveMode(connection);
  // Before the budget and limit checks: a signed-out CLI is the reason to show, not a limit.
  if (mode === "claude_code") assertSubscriptionReady();
  if (options.enforceBudget && mode !== "claude_code" && budgetStatus({ ...ctx, settings }).exceeded) {
    throw new AiError("budget", "AI budget cap reached");
  }
  if (options.enforceBudget && mode === "claude_code") {
    const until = subscriptionLimitedUntil();
    if (until) throw new AiError("subscription_limit", "Claude subscription usage limit reached", { resetsAt: until.toISOString() });
  }
  return { settings, connection, mode, model: options.model ?? resolved.model, effort: options.effort ?? resolved.effort };
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
  /** Bulk/background work is blocked once the budget cap (or the subscription's limit) is reached; interactive calls only warn. */
  enforceBudget?: boolean;
  model?: ModelId;
  effort?: Effort;
  /** Use this connection instead of the task's (a chat thread stays on the one it started with). */
  connection?: Connection;
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
  /** Answered by the demo simulator (fake transport), not a real model. Stored with cached output. */
  simulated: boolean;
}

/**
 * One streamed Messages API call with Huntloop's conventions applied. Callers inspect
 * `stop_reason` themselves (chat needs to handle `tool_use` / `pause_turn` / `refusal`).
 */
export async function callModel(ctx: AiContext, task: AiTask, request: CallRequest, options: CallOptions = {}): Promise<CallResult> {
  const call = await resolveCall(ctx, task, options);
  // Subscription calls run whole agent turns through the CLI (see claude-code/); callers branch first.
  if (call.mode === "claude_code") throw new Error(`callModel can't serve ${task} through Claude Code`);
  const { model, effort } = call;
  const mode = call.mode === "api" ? "live" : "fake";
  const client = getAnthropic(mode);
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
    via: "api",
  });
  return { message, model, effort, cost, simulated: mode === "fake" };
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
  const call = await resolveCall(ctx, task, options);
  if (call.mode === "claude_code") return callStructuredViaCli(ctx, task, request, call);
  const format = apiOutputFormat(request.schema);
  let maxTokens = options.maxTokens ?? 32_000;
  for (let attempt = 0; attempt < 2; attempt++) {
    let result: CallResult;
    try {
      result = await callModel(
        ctx,
        task,
        { system: request.system, messages: request.messages, tools: request.tools, output_config: { format } },
        { ...options, connection: call.connection, maxTokens },
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
