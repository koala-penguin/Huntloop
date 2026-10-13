import type Anthropic from "@anthropic-ai/sdk";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { resolveTaskModel, type AiTask, type Connection } from "@/shared/ai-settings";
import type { JobStatus } from "@/shared/schemas/job";
import { stableStringify } from "@/shared/stable-json";
import type { Effort, ModelId } from "@/shared/models";
import { chatActions, chatMessages, conversations, type ChatActionRow, type ChatMessageRow, type ConversationRow, type JobRow } from "../../db/schema";
import { AiError, callModel, resolveMode, settingsFor, type AiContext } from "../client";
import { runCliChatTurn } from "../claude-code/chat";
import { getJob, setJobStatus, updateJob } from "../../repo/jobs";
import { getCurrentProfile, getPreferences } from "../../repo/profile";
import { getLocalUser, userLocale } from "../../repo/users";
import { loadJobFit } from "../../jobs/fit";
import { UserFacingError } from "../../errors";
import { jobChatContext, jobChatSystem, jobStateDigest } from "./context";
import { JOB_CHAT_TOOLSET_VERSION, isClientTool, jobChatTools, toolInputSchemas } from "./tools";
import { companyResearchHooks } from "./research-hooks";
import { latestCvDocument } from "../../repo/cv-documents";
import { startTailoring } from "../../jobs/proceed";
import { blockingCount } from "@/shared/schemas/cv";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

export type ChatEvent =
  | { type: "start"; conversationId: number }
  | { type: "text"; delta: string }
  | { type: "progress"; text: string }
  | { type: "tool"; name: string; detail: string | null }
  | { type: "card"; actionId: number }
  | { type: "done" }
  | { type: "error"; code: string; message?: string };

const MAX_STEPS = 8;
const busy = ((globalThis as unknown as { huntloopChatBusy?: Set<number> }).huntloopChatBusy ??= new Set());

export function isConversationBusy(id: number): boolean {
  return busy.has(id);
}

export function getJobConversation(ctx: Pick<AiContext, "db" | "userId">, jobId: number): ConversationRow | undefined {
  return ctx.db
    .select()
    .from(conversations)
    .where(and(eq(conversations.userId, ctx.userId), eq(conversations.jobId, jobId)))
    .orderBy(desc(conversations.id))
    .get();
}

export function listChatMessages(ctx: Pick<AiContext, "db">, conversationId: number): ChatMessageRow[] {
  return ctx.db.select().from(chatMessages).where(eq(chatMessages.conversationId, conversationId)).orderBy(asc(chatMessages.seq)).all();
}

export function listChatActions(ctx: Pick<AiContext, "db">, conversationId: number): ChatActionRow[] {
  return ctx.db.select().from(chatActions).where(eq(chatActions.conversationId, conversationId)).orderBy(asc(chatActions.id)).all();
}

function researchReady(ctx: Pick<AiContext, "db" | "userId">, job: JobRow): boolean {
  return companyResearchHooks.isReady(ctx, job);
}

function cvDraftState(ctx: Pick<AiContext, "db" | "userId">, job: JobRow): { version: number; blocking: number } | null {
  const doc = latestCvDocument(ctx.db, ctx.userId, "cv", job.id);
  return doc ? { version: doc.version, blocking: blockingCount(doc.flags) } : null;
}

function currentDigest(ctx: AiContext, job: JobRow, conversationId: number | null) {
  const fit = loadJobFit(ctx.db, ctx.userId, job);
  const actions = conversationId ? listChatActions(ctx, conversationId) : [];
  return {
    fit,
    digest: <Record<string, unknown>>{
      ...jobStateDigest(job, fit, researchReady(ctx, job), cvDraftState(ctx, job)),
      actions: Object.fromEntries(actions.map((a) => [a.toolUseId, a.status])),
    },
  };
}

/** Starts a conversation about a job, freezing its system prompt, tools, model, effort and context. */
export function createJobConversation(ctx: AiContext, job: JobRow, now = new Date()): ConversationRow {
  const { model, effort, connection } = resolveTaskModel(settingsFor(ctx), "chat");
  const language = userLocale(getLocalUser(ctx.db));
  const { fit, digest } = currentDigest(ctx, job, null);
  const conversation = ctx.db
    .insert(conversations)
    .values({
      userId: ctx.userId,
      jobId: job.id,
      kind: "job",
      model,
      effort,
      provider: connection,
      toolsetVersion: JOB_CHAT_TOOLSET_VERSION,
      system: jobChatSystem(job, language, now.toISOString().slice(0, 10)),
      tools: jobChatTools(model, job.country),
      stateDigest: stableStringify(digest),
      updatedAt: now,
    })
    .returning()
    .get();
  const context = jobChatContext(job, fit, getCurrentProfile(ctx.db, ctx.userId), getPreferences(ctx.db, ctx.userId), companyResearchHooks.summaryFor(ctx, job));
  ctx.db.insert(chatMessages).values({ conversationId: conversation.id, seq: 0, role: "user", kind: "context", content: context }).run();
  return conversation;
}

/** Rows → API messages. Consecutive rows of the same role become one message (deterministically). */
export function toApiMessages(rows: ChatMessageRow[]): MessageParam[] {
  const out: MessageParam[] = [];
  for (const row of rows) {
    const content = row.content as ContentBlockParam[];
    const last = out.at(-1);
    if (last && last.role === row.role) last.content = [...(last.content as ContentBlockParam[]), ...content];
    else out.push({ role: row.role as "user" | "assistant", content: [...content] });
  }
  return out;
}

/** tool_use blocks of the last assistant message that never got a result (e.g. cut off by max_tokens). */
function unresolvedToolUses(rows: ChatMessageRow[]): string[] {
  const last = rows.at(-1);
  if (!last || last.role !== "assistant") return [];
  return (last.content as ContentBlock[]).filter((b) => b.type === "tool_use").map((b) => (b as { id: string }).id);
}

/** Human-readable differences between what the model was last told and the job's state now. */
export function describeStateChange(before: Record<string, unknown> | null, after: Record<string, unknown>, actions: ChatActionRow[]): string | null {
  if (!before) return null;
  const lines: string[] = [];
  const changed = (key: string) => stableStringify(before[key]) !== stableStringify(after[key]);
  if (changed("status")) lines.push(`Job status is now "${after.status}".`);
  if (changed("tier") || changed("eligibility")) lines.push(`Interview Chance is now ${after.tier ?? "not scored"} (${after.eligibility ?? "unknown eligibility"}).`);
  if (changed("gates")) lines.push(`Eligibility gates now: ${(after.gates as string[]).join("; ") || "none"}.`);
  if (changed("statuses")) {
    const b = (before.statuses ?? {}) as Record<string, string>;
    const a = after.statuses as Record<string, string>;
    const diffs = Object.keys(a).filter((k) => a[k] !== b[k]).map((k) => `${k}: ${b[k] ?? "?"} → ${a[k]}`);
    if (diffs.length) lines.push(`Requirement statuses changed: ${diffs.join(", ")}.`);
  }
  if (changed("answers")) lines.push(`The candidate's answers to requirement questions: ${stableStringify(after.answers)}.`);
  if (changed("profileStale") && after.profileStale) lines.push("The candidate's profile (CV, skills or facts) changed since the fit assessment; statuses may be out of date.");
  if (changed("actions")) {
    const b = (before.actions ?? {}) as Record<string, string>;
    for (const action of actions) {
      if (b[action.toolUseId] === action.status || action.status === "pending") continue;
      const payload = action.payload as Record<string, unknown>;
      const what = action.kind === "profile_fact" ? `the profile fact "${payload.fact}"` : "proceeding with this job (status set to applying; Huntloop is drafting a tailored CV in the CV tab)";
      lines.push(`The candidate ${action.status === "accepted" ? "accepted" : "dismissed"} ${what}.`);
    }
  }
  if (changed("researchReady") && after.researchReady) lines.push("Employer research has finished; its report is included below.");
  if (changed("cvDraft") && after.cvDraft) {
    const draft = after.cvDraft as { version: number; blocking: number };
    lines.push(
      `Tailored CV draft version ${draft.version} is ready in the CV tab.${draft.blocking ? ` ${draft.blocking} line(s) couldn't be traced to the CV or confirmed facts; the candidate must fix or remove them before exporting.` : ""}`,
    );
  }
  return lines.length ? lines.join("\n") : null;
}

async function runTool(ctx: AiContext, conversation: ConversationRow, job: JobRow, block: { id: string; name: string; input: unknown }, emit: (e: ChatEvent) => void, messageId: number): Promise<ToolResult> {
  const result = (content: string, isError = false): ToolResult => ({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
  if (!isClientTool(block.name)) return result(`Unknown tool ${block.name}`, true);
  const parsed = toolInputSchemas[block.name].safeParse(block.input);
  if (!parsed.success) return result(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, true);
  const input = parsed.data as Record<string, unknown>;

  switch (block.name) {
    case "save_job_note": {
      const current = getJob(ctx.db, ctx.userId, job.id);
      const stamp = new Date().toISOString().slice(0, 10);
      updateJob(ctx.db, job.id, { notes: [current?.notes, `${stamp}: ${input.note}`].filter(Boolean).join("\n") });
      emit({ type: "tool", name: "save_job_note", detail: String(input.note) });
      return result("Note saved on the job.");
    }
    case "set_job_status": {
      setJobStatus(ctx.db, ctx.userId, job.id, input.status as JobStatus, String(input.reason));
      emit({ type: "tool", name: "set_job_status", detail: String(input.status) });
      return result(`Status set to ${input.status}.`);
    }
    case "propose_profile_fact":
    case "propose_proceed": {
      const action = ctx.db
        .insert(chatActions)
        .values({ conversationId: conversation.id, messageId, toolUseId: block.id, kind: block.name === "propose_profile_fact" ? "profile_fact" : "proceed", payload: input })
        .returning()
        .get();
      emit({ type: "card", actionId: action.id });
      return result("Shown to the candidate as a confirmation card. Nothing changes unless they accept; you will be told what they decide.");
    }
    case "revise_cv_draft": {
      const draft = latestCvDocument(ctx.db, ctx.userId, "cv", job.id);
      if (!draft) return result("There is no tailored CV draft for this job yet. It is written once the candidate proceeds (propose_proceed).", true);
      const taskId = startTailoring(ctx.db, ctx.userId, job.id, { revise: { fromDocId: draft.id, instructions: String(input.instructions) } });
      emit({ type: "tool", name: "revise_cv_draft", detail: String(input.instructions) });
      return taskId
        ? result(`Writing version ${draft.version + 1} of the CV draft. It will appear in the CV tab; you'll be told when it's ready.`)
        : result("The CV draft can't be revised right now.", true);
    }
    case "start_company_research": {
      const started = companyResearchHooks.start(ctx, job);
      emit({ type: "tool", name: "start_company_research", detail: null });
      return started.ok ? result(started.message) : result(started.message, true);
    }
  }
}

/**
 * What differs between kinds of conversation (one job, or the coach across all jobs): the state
 * the model is kept up to date about, the context-update text, and the client tools.
 */
export interface ChatScope {
  task: AiTask;
  digest(): Record<string, unknown>;
  contextUpdate(previous: Record<string, unknown> | null, digest: Record<string, unknown>): string | null;
  runTool(block: { id: string; name: string; input: unknown }, emit: (e: ChatEvent) => void, messageId: number): Promise<ToolResult>;
}

type ScopeFactory = (ctx: AiContext, conversation: ConversationRow) => ChatScope;
const scopes = ((globalThis as unknown as { huntloopChatScopes?: Map<string, ScopeFactory> }).huntloopChatScopes ??= new Map());

export function registerChatScope(kind: string, factory: ScopeFactory): void {
  scopes.set(kind, factory);
}

function jobScope(ctx: AiContext, conversation: ConversationRow): ChatScope {
  if (!conversation.jobId) throw new UserFacingError("not_found");
  let job = getJob(ctx.db, ctx.userId, conversation.jobId);
  if (!job) throw new UserFacingError("not_found");
  return {
    task: "chat",
    digest: () => {
      job = getJob(ctx.db, ctx.userId, job!.id) ?? job!;
      return currentDigest(ctx, job, conversation.id).digest;
    },
    contextUpdate: (previous, digest) => {
      const update = describeStateChange(previous, digest, listChatActions(ctx, conversation.id));
      if (!update) return null;
      const research = digest.researchReady && previous && !previous.researchReady ? companyResearchHooks.summaryFor(ctx, job!) : null;
      return `${update}${research ? `\n<employer_research>\n${research}\n</employer_research>` : ""}`;
    },
    runTool: (block, emit, messageId) => runTool(ctx, conversation, job!, block, emit, messageId),
  };
}

registerChatScope("job", jobScope);

/**
 * One user turn: append the message, call Claude (streaming), run client tools, repeat until the
 * turn ends. Every response is stored verbatim before the next request, so each request extends
 * the previous one. On a refusal or error, nothing from this turn is kept.
 */
export async function runChatTurn(ctx: AiContext, conversationId: number, userText: string, emit: (e: ChatEvent) => void): Promise<void> {
  if (busy.has(conversationId)) throw new UserFacingError("chat_busy");
  busy.add(conversationId);
  const turnRows: number[] = [];
  const insertRow = (row: Omit<typeof chatMessages.$inferInsert, "conversationId" | "seq">) => {
    const last = ctx.db.select({ seq: chatMessages.seq }).from(chatMessages).where(eq(chatMessages.conversationId, conversationId)).orderBy(desc(chatMessages.seq)).get();
    const inserted = ctx.db
      .insert(chatMessages)
      .values({ ...row, conversationId, seq: (last?.seq ?? -1) + 1 })
      .returning()
      .get();
    turnRows.push(inserted.id);
    return inserted;
  };
  const rollback = () => {
    if (turnRows.length) {
      ctx.db.delete(chatActions).where(and(eq(chatActions.conversationId, conversationId), inArray(chatActions.messageId, turnRows))).run();
      ctx.db.delete(chatMessages).where(inArray(chatMessages.id, turnRows)).run();
    }
  };

  try {
    const conversation = ctx.db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.userId, ctx.userId))).get();
    const factory = conversation ? scopes.get(conversation.kind) : undefined;
    if (!conversation || !factory) throw new UserFacingError("not_found");
    const scope = factory(ctx, conversation);
    emit({ type: "start", conversationId });

    // The user's message: results for any dangling tool calls, then context updates, then their text.
    const rows = listChatMessages(ctx, conversationId);
    const content: ContentBlockParam[] = unresolvedToolUses(rows).map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "Not run: the previous response was cut off before this tool could run.",
      is_error: true,
    }));
    const digest = scope.digest();
    const previous = conversation.stateDigest ? (JSON.parse(conversation.stateDigest) as Record<string, unknown>) : null;
    const update = scope.contextUpdate(previous, digest);
    if (update) content.push({ type: "text", text: `<context_update>\n${update}\n</context_update>` });
    content.push({ type: "text", text: userText });
    insertRow({ role: "user", kind: "user", content, text: userText });

    const model = conversation.model as ModelId;
    const effort = conversation.effort as Effort;
    const provider = conversation.provider as Connection;
    const viaCli = (await resolveMode(provider)) === "claude_code";
    if (viaCli) {
      // The user's Claude subscription: Claude Code runs the turn; the thread continues its session.
      const sessionId = await runCliChatTurn({
        ctx,
        conversation,
        task: scope.task,
        context: conversation.providerSession ? null : rows.filter((r) => r.kind === "context").flatMap((r) => r.content as ContentBlockParam[]),
        user: content,
        emit,
        insertRow,
        runTool: (block, messageId) => scope.runTool(block, emit, messageId),
      });
      ctx.db.update(conversations).set({ providerSession: sessionId }).where(eq(conversations.id, conversationId)).run();
    }
    for (let step = 0; step < MAX_STEPS && !viaCli; step++) {
      const blocks = new Map<number, { type: string; name?: string; json: string }>();
      const { message } = await callModel(
        ctx,
        scope.task,
        {
          system: conversation.system,
          messages: toApiMessages(listChatMessages(ctx, conversationId)),
          tools: conversation.tools as Anthropic.Beta.Messages.BetaToolUnion[],
          cache_control: { type: "ephemeral" },
        },
        {
          model,
          effort,
          connection: provider,
          maxTokens: 16_000,
          progressUpdates: true,
          prefixMismatch: process.env.NODE_ENV === "test" ? "error" : "drop_block",
          onEvent: (event) => {
            if (event.type === "content_block_start") {
              const block = event.content_block as { type: string; name?: string; input?: unknown };
              blocks.set(event.index, { type: block.type, name: block.name, json: "" });
            } else if (event.type === "content_block_delta") {
              const delta = event.delta as { type: string; text?: string; thinking?: string; partial_json?: string };
              if (delta.type === "text_delta" && delta.text) emit({ type: "text", delta: delta.text });
              else if (delta.type === "thinking_delta" && delta.thinking?.trim()) emit({ type: "progress", text: delta.thinking.trim() });
              else if (delta.type === "input_json_delta") {
                const b = blocks.get(event.index);
                if (b) b.json += delta.partial_json ?? "";
              }
            } else if (event.type === "content_block_stop") {
              const b = blocks.get(event.index);
              if (b?.type === "server_tool_use") {
                let detail: string | null = null;
                try {
                  const input = JSON.parse(b.json || "{}") as { query?: string; url?: string };
                  detail = input.query ?? input.url ?? null;
                } catch {
                  detail = null;
                }
                emit({ type: "tool", name: b.name ?? "web", detail });
              }
            }
          },
        },
      );

      const transformations = (message as { input_transformations?: unknown[] }).input_transformations;
      if (transformations?.length) console.warn(`[huntloop] chat ${conversationId}: request was transformed`, transformations);

      if (message.stop_reason === "refusal") throw new AiError("refusal", "Claude declined to answer");
      const assistant = insertRow({
        role: "assistant",
        kind: "assistant",
        content: message.content,
        stopReason: message.stop_reason,
        servedModel: message.model ?? null,
        usage: message.usage,
      });

      if (message.stop_reason === "pause_turn") continue;
      if (message.stop_reason === "tool_use") {
        const toolUses = message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
        const results: ToolResult[] = [];
        for (const use of toolUses) results.push(await scope.runTool(use, emit, assistant.id));
        insertRow({ role: "user", kind: "tool_results", content: results });
        continue;
      }
      if (message.stop_reason === "max_tokens") emit({ type: "error", code: "max_tokens" });
      break;
    }

    const after = scope.digest();
    ctx.db.update(conversations).set({ stateDigest: stableStringify(after), updatedAt: new Date() }).where(eq(conversations.id, conversationId)).run();
    emit({ type: "done" });
  } catch (error) {
    rollback();
    const code = error instanceof AiError || error instanceof UserFacingError ? error.code : "api";
    emit({ type: "error", code, message: error instanceof Error ? error.message : String(error) });
    if (!(error instanceof AiError) && !(error instanceof UserFacingError)) console.error("[huntloop] chat turn failed", error);
  } finally {
    busy.delete(conversationId);
  }
}

/** The per-job chat's entry point (kept for the job chat route and tests). */
export const runJobChatTurn = runChatTurn;
