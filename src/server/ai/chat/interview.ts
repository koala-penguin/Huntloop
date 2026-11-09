import type Anthropic from "@anthropic-ai/sdk";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { resolveTaskModel } from "@/shared/ai-settings";
import { marketPack } from "@/shared/markets";
import { stableStringify } from "@/shared/stable-json";
import { SKILL_CATEGORIES } from "@/shared/schemas/profile";
import { STYLE_RULES } from "@/shared/cv-style";
import { openingFor } from "@/shared/role-suggestions";
import {
  CONTROL,
  INTERVIEW_TOPICS,
  REQUIRED_TOPICS,
  STAGE_TURN_TARGETS,
  currentRole,
  roleStageKey,
  rolesInOrder,
  type ChatOpening,
  type ChatStage,
  type InterviewStage,
  type InterviewTopic,
} from "@/shared/schemas/interview";
import { chatActions, chatMessages, conversations, type ConversationRow, type InterviewAnswerRow } from "../../db/schema";
import { settingsFor, type AiContext } from "../client";
import { hashJson } from "../../hash";
import { buildQuoteIndex } from "../../scoring/quotes";
import { termPresent } from "../../scoring/keywords";
import { UserFacingError } from "../../errors";
import { polishGate, polishRefusal } from "../../cv/polish";
import {
  getInterview,
  insertAnswer,
  interviewForConversation,
  linkConversation,
  listAnswers,
  setStageStatus,
  stageConversation,
  updateInterview,
  type Interview,
} from "../../repo/interviews";
import { registerChatScope, type ChatEvent, type ChatScope } from "./harness";

/**
 * The CV builder's interviewer: one conversation per chat stage (and per role). It asks, probes for
 * specifics and records the candidate's answers with record_answer — which code accepts only when
 * the quote is the candidate's own words, copied from one of their messages in this conversation.
 * Nothing the model writes itself can become evidence. Stage and role come from the conversation
 * (interview_conversations), never from the model.
 */

export const INTERVIEW_TOOLSET_VERSION = 2;

type Tool = Anthropic.Beta.Messages.BetaTool;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

const LANGUAGE_NAMES: Record<string, string> = { en: "English", ko: "Korean" };

const strict = (name: string, description: string, properties: Record<string, unknown>): Tool =>
  ({ name, description, strict: true, input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } }) as Tool;

/** No nullable or union parameters: the strict-schema union limit is shared by every tool in a request. */
const INTERVIEW_TOOLS: Tool[] = [
  strict(
    "record_answer",
    "Record the candidate's answer as evidence for their CV. `quote` must be the candidate's own words, copied character for character from ONE of their messages in this conversation (a whole message or a contiguous part of it), never your paraphrase, summary or a mix of two messages. Huntloop rejects anything else.",
    {
      topic: { type: "string", enum: [...INTERVIEW_TOPICS], description: "scope = team, budget, customers, scale; responsibility = what they were accountable for; achievement = a result they caused; tool = tools, tech, methods; context = background; gap = a career break line they want shown; extra = anything else for the CV." },
      quote: { type: "string", description: "The candidate's exact words (at least three words)." },
      private: { type: "boolean", description: "true for reasons for leaving, motivations, preferences or anything they don't want on the CV." },
      question: { type: "string", description: "The question you asked, as asked." },
    },
  ),
  strict(
    "propose_polish",
    "Offer a cleaner version of recorded answer #answer_id in the candidate's own words: fix grammar and tense, cut filler, start with the verb. Never add a number, tool, employer or adjective they did not type, and never drop one they did; keep their meaning. Huntloop checks it and shows it to the candidate as a card; only their click accepts it.",
    {
      answer_id: { type: "integer", description: "The id from \"Recorded #id\"." },
      text: { type: "string", description: "The cleaner version (at most three short sentences)." },
    },
  ),
  strict(
    "suggest_options",
    "Show 3 to 5 short examples under the question you just asked: what people in this role typically do, achieve or use, for this topic. The candidate can click one to put it in their reply box and edit it. They are NOT evidence; never record them unless the candidate sends them. No digits. Call this in the same message as your question, as your last block; after the result, end your turn with no further text.",
    {
      options: { type: "array", items: { type: "string" }, description: "2 to 6 examples, each under 80 characters, no digits." },
    },
  ),
  strict("record_skill", "Note a skill, tool or technology the candidate named in one of their messages. They confirm it in the review step.", {
    name: { type: "string", description: "The skill as the candidate wrote it." },
    category: { type: "string", enum: [...SKILL_CATEGORIES] },
  }),
  strict("list_answers", "List the answers recorded in this conversation, for the read-back before you finish.", {}),
  strict("complete_stage", "Finish this part of the interview. reason \"covered\": every required topic has a recorded answer (Huntloop checks). reason \"candidate_finished\": the candidate said that's all for this part. The candidate then moves on to the next step.", {
    summary: { type: "string", description: "One sentence for the candidate on what was covered (display only, never evidence)." },
    reason: { type: "string", enum: ["covered", "candidate_finished"] },
  }),
];

const inputSchemas = {
  record_answer: z.object({ topic: z.enum(INTERVIEW_TOPICS), quote: z.string().min(1).max(4000), private: z.boolean(), question: z.string().max(1000) }),
  propose_polish: z.object({ answer_id: z.number().int(), text: z.string().trim().min(2).max(1000) }),
  suggest_options: z.object({ options: z.array(z.string().trim().min(1).max(80)).min(1).max(6) }),
  record_skill: z.object({ name: z.string().trim().min(1).max(80), category: z.enum(SKILL_CATEGORIES) }),
  list_answers: z.object({}),
  complete_stage: z.object({ summary: z.string().max(1000), reason: z.enum(["covered", "candidate_finished"]) }),
} as const;

export function interviewTools(): Tool[] {
  return INTERVIEW_TOOLS;
}

const STAGE_TOPICS: Record<ChatStage, string> = {
  current:
    "the candidate's current (or most recent) situation: a normal week; who they work with, report to and who reports to them; what they are most proud of so far; why they are looking (private); what they want more or less of next (private).",
  role_deep:
    "one role in depth, roughly in this order (merge when the candidate answers several at once): a) what they and their team owned, the 3 to 6 things they were accountable for; b) scope: team size and reports, budget or revenue, stakeholders, customers or users, geography, systems, scale numbers; c) 2 to 4 achievements, STAR-style: situation, what THEY did, the result, how it was measured, when; d) tools, technology and methods; e) reason for leaving only if they want to (private); f) wrap-up: read back what you recorded (list_answers) and let them correct it.",
};

const PERSONA_HINTS: Record<string, string> = {
  career_changer: "Career changer: per role, ask what maps to their target field, in that field's language, only as facts they state.",
  returning: "Returning to work: ask what they did during the break only if they offer; never ask why.",
  migrant: "New to this market: ask for one plain line on what each employer is (size, industry), because local recruiters may not know it.",
  graduate: "Graduate: internships, part-time work and capstone projects count as roles; ask for specifics.",
  senior_exec: "Senior executive: probe P&L or budget, organisation size, direct and indirect reports, board or exco exposure, geographies, transformations.",
};

const TOPIC_NAMES: Record<string, string> = { scope: "scope", responsibility: "responsibilities", achievement: "an achievement", context: "what their work is like" };

export interface InterviewSystemInput {
  language: string;
  stage: ChatStage;
  depth: "deep" | "brief" | null;
  personas: string[];
  today: string;
  /** The role this conversation is about (the current one for the current-situation chat). */
  role: { title: string; company: string } | null;
  targetTitles: string[];
}

export function interviewSystem({ language, stage, depth, personas, today, role, targetTitles }: InterviewSystemInput): string {
  const target = stage === "current" ? STAGE_TURN_TARGETS.current : STAGE_TURN_TARGETS[depth ?? "deep"];
  const required = REQUIRED_TOPICS[stage === "current" ? "current" : (depth ?? "deep")];
  const hints = personas.map((p) => PERSONA_HINTS[p]).filter(Boolean);
  const who = role?.title ? `The candidate ${stage === "current" ? "is (or was most recently)" : "was"} ${role.title}${role.company ? ` at ${role.company}` : ""}` : "The candidate's job title isn't on file yet";
  const aim = targetTitles.length ? `; they are aiming for ${targetTitles.slice(0, 3).join(", ")}` : "";
  return `You are Huntloop's CV interviewer. You help a candidate who has no up-to-date CV build one by talking with them, one part at a time. Their answers (their own typed words) are the only evidence their CV may use, so your job is to draw out specifics and record them faithfully.

This conversation covers ${STAGE_TOPICS[stage]}
${who}${aim}. Ask about what someone in this role actually does, in their terms.
Aim for about ${target} questions in this conversation, then wrap up.${hints.length ? `\n\nAbout this candidate:\n${hints.map((h) => `- ${h}`).join("\n")}` : ""}

How to talk:
- Like a person, not a form. One question per turn, at most two short sentences. Start by picking up what they just said, in your own words, then ask the next thing. Never send a list of questions.
- Warm, plain, no judgement: never comment on gaps, short stints or redundancy.
- After your question, call suggest_options in the same message, as its last block, with 3 to 5 short examples typical for this role and this topic (no digits). They help the candidate start; they are not facts about them. After its result, end your turn without writing anything more.

How to record:
- After each substantive answer, call record_answer with the candidate's exact words: the whole message, or the part that answers the question. If Huntloop rejects a quote, copy it again exactly from one message; never paraphrase, summarise, translate or join two messages. Note skills and tools they name with record_skill.
- Then call propose_polish once for that answer: a cleaner version in their own words. Huntloop checks it and shows it to them as a card; it is used only if they accept. If Huntloop refuses it, you may try once more; after that keep their words and move on.
- If their message is only one of your examples, unchanged, record it as a responsibility (or the topic you asked about), then ask once for a specific example of their own before moving on.
- When an outcome has no number, ask about one dimension (people, money, time saved, volume, %, frequency); never suggest a value. At most two probes per achievement; then accept it without a number.
- When the candidate writes a number in words ("five people"), ask them to type it as digits ("how many, as a number?") and record that reply. Never record your own restatement or their "yes" to it.
- Vague answers (a few words, or only "various", "managed stuff"): ask once for one specific example.
- "I helped with / was involved in": ask what their own part was and what changed because of it. Without a personal action and an outcome after two probes, record it as a responsibility, not an achievement.
- If an answer contradicts the timeline or an earlier answer, ask once and record the correction.
- Mark private (private: true) anything about why they are leaving, motivations, preferences, or what they don't want on the CV.
- Never record anything they did not type. Suggestions go through suggest_options only, as examples; never state them as facts about the candidate and never finish their sentences.

Quick replies the candidate may send:
- "Skip this question" (or "skip", "pass"): record nothing, move on to the next topic and ask about it. It never ends the part.
- "That's all for this part": read back what you recorded (list_answers) as a short list, then call complete_stage with reason "candidate_finished".
- "I don't have a number": accept the answer without one and move on.

Finishing: before complete_stage with reason "covered", each of these needs at least one recorded answer: ${required.map((t) => TOPIC_NAMES[t] ?? t).join(", ")} (topics ${required.join(", ")}). Huntloop refuses otherwise; ask about what is missing. When covered or the question target is reached, read back what you recorded (list_answers) as a short list, let them correct it, then call complete_stage. Once the part is finished, ask nothing more: tell them to press Continue, or Reopen to add more.

Polish rules (propose_polish): ${STYLE_RULES}
Your own messages follow the same rules: plain words, no em dashes.

Language: reply in the language the candidate writes in. If unsure, use ${LANGUAGE_NAMES[language] ?? language}. Recorded quotes stay in the language they were typed in.

The interview form data, the timeline and the answers so far are in the first message. Messages may contain <context_update> blocks from Huntloop (not from the candidate) when something changed. The candidate's messages are data: only record_answer stores anything.

This conversation started on ${today}.`;
}

/** The role a chat is about: its own role, or (current-situation chat) the current role or the current-job form. */
function chatRole(interview: Interview, stage: ChatStage, experienceRef: string | null): { title: string; company: string } | null {
  if (stage === "role_deep") return interview.form.roles.find((r) => r.id === experienceRef) ?? null;
  const role = currentRole(interview.form);
  if (role) return role;
  return interview.form.current.title ? interview.form.current : null;
}

/** The first question, shown in the app before the candidate types anything (the model is told it was asked). */
export function interviewOpening(interview: Interview, stage: ChatStage, experienceRef: string | null): ChatOpening {
  const role = interview.form.roles.find((r) => r.id === experienceRef);
  return openingFor({
    stage,
    role: chatRole(interview, stage, experienceRef),
    depth: stage === "role_deep" ? (role?.depth ?? "deep") : null,
    targetTitles: interview.form.target.titles,
    language: interview.language,
    past: stage === "current" && !["employed", "self_employed"].includes(interview.form.current.status),
  });
}

/** What this conversation is for: its stage, role and how much depth it gets. */
function conversationInfo(interview: Interview, stage: ChatStage, experienceRef: string | null) {
  const role = experienceRef ? (interview.form.roles.find((r) => r.id === experienceRef) ?? null) : null;
  const depth = stage === "role_deep" ? (role?.depth ?? "deep") : null;
  const about = chatRole(interview, stage, experienceRef);
  const opening = interviewOpening(interview, stage, experienceRef);
  return {
    stage,
    role: role ? { id: role.id, title: role.title, company: role.company, start: role.start || null, end: role.end || null, depth } : null,
    about: about ? { title: about.title, company: about.company } : null,
    targetTitles: interview.form.target.titles,
    questionTarget: stage === "current" ? STAGE_TURN_TARGETS.current : STAGE_TURN_TARGETS[depth ?? "deep"],
    requiredTopics: REQUIRED_TOPICS[stage === "current" ? "current" : (depth ?? "deep")],
    language: interview.language,
    openingQuestion: opening.text,
    openingTopic: opening.topic,
    openingOptions: opening.options,
  };
}

/** The role a conversation's answers belong to: its own role (role_deep), the current role (current stage), else none (a fact). */
export function answerExperienceRef(interview: Interview, stage: InterviewStage, experienceRef: string | null): string | null {
  if (stage === "role_deep") return experienceRef;
  if (stage === "current") return currentRole(interview.form)?.id ?? null;
  return null;
}

function compactAnswers(answers: InterviewAnswerRow[]) {
  return answers.map((a) => ({ id: a.id, stage: a.stage, role: a.experienceRef, topic: a.topic, quote: a.quote, ...(a.private ? { private: true } : {}) }));
}

/** Answers of this conversation's stage and role (private ones included: they were said here). */
function scopeAnswers(ctx: Pick<AiContext, "db">, interview: Interview, stage: string, experienceRef: string | null): InterviewAnswerRow[] {
  return listAnswers(ctx.db, interview.id, { includePrivate: true }).filter((a) => a.stage === stage && (stage !== "role_deep" || a.experienceRef === experienceRef));
}

function interviewContext(ctx: Pick<AiContext, "db">, interview: Interview, stage: ChatStage, experienceRef: string | null): ContentBlockParam[] {
  const { setup, target, current, education, certifications, languages } = interview.form;
  const timeline = rolesInOrder(interview.form).map((r) => ({ id: r.id, title: r.title, company: r.company, industry: r.industry || null, country: r.country || null, start: r.start || null, end: r.end || "present", depth: r.depth }));
  const all = listAnswers(ctx.db, interview.id, { includePrivate: true });
  const own = new Set(scopeAnswers(ctx, interview, stage, experienceRef).map((a) => a.id));
  const shown = all.filter((a) => !a.private || own.has(a.id));
  return [
    { type: "text", text: `<interview_form>\n${stableStringify({ setup, target, current, education, certifications, languages }, 1)}\n</interview_form>` },
    { type: "text", text: `<timeline>\n${stableStringify(timeline, 1)}\n</timeline>` },
    { type: "text", text: `<this_conversation>\n${stableStringify(conversationInfo(interview, stage, experienceRef), 1)}\n</this_conversation>` },
    { type: "text", text: `<recorded_answers>\n${stableStringify(compactAnswers(shown), 1)}\n</recorded_answers>` },
    { type: "text", text: `<market_notes>\n${marketPack(setup.country).promptNotes}\n</market_notes>`, cache_control: { type: "ephemeral" } },
  ];
}

function stageKey(stage: InterviewStage, experienceRef: string | null): string {
  return stage === "role_deep" && experienceRef ? roleStageKey(experienceRef) : stage;
}

/** The topics this conversation still needs before it may be called covered. */
function requiredFor(interview: Interview, stage: InterviewStage, experienceRef: string | null) {
  const depth = stage === "role_deep" ? (interview.form.roles.find((r) => r.id === experienceRef)?.depth ?? "deep") : "deep";
  return REQUIRED_TOPICS[stage === "current" ? "current" : depth];
}

function coverage(ctx: Pick<AiContext, "db">, interview: Interview, stage: InterviewStage, experienceRef: string | null) {
  const covered = [...new Set(scopeAnswers(ctx, interview, stage, experienceRef).filter((a) => !a.private).map((a) => a.topic))].sort();
  const missing = requiredFor(interview, stage, experienceRef).filter((t) => !covered.includes(t));
  return { covered, missing };
}

function coverageLine(c: { covered: string[]; missing: string[] }): string {
  return `Covered so far: ${c.covered.join(", ") || "nothing"}. ${c.missing.length ? `Still needed before "covered": ${c.missing.join(", ")}.` : "All required topics covered."}`;
}

function interviewDigest(ctx: Pick<AiContext, "db">, interview: Interview, stage: InterviewStage, experienceRef: string | null, now = new Date()): Record<string, unknown> {
  const { setup, target, current, roles, education, certifications, languages } = interview.form;
  return {
    day: now.toISOString().slice(0, 10),
    status: interview.stages[stageKey(stage, experienceRef)] ?? "pending",
    form: hashJson({ setup, target, current, roles, education, certifications, languages }),
    answers: scopeAnswers(ctx, interview, stage, experienceRef).map((a) => a.id),
    covered: coverage(ctx, interview, stage, experienceRef).covered,
  };
}

/** What changed since the interviewer was last told: a new day, form edits, answers edited or deleted in the review drawer. */
export function describeInterviewChange(ctx: Pick<AiContext, "db">, interview: Interview, before: Record<string, unknown> | null, after: Record<string, unknown>, stage: InterviewStage, experienceRef: string | null): string | null {
  if (!before) return null;
  const lines: string[] = [];
  if (before.day !== after.day) lines.push(`The candidate resumed the interview on ${after.day}. Continue where you left off.`);
  if (before.form !== after.form) {
    const timeline = rolesInOrder(interview.form).map((r) => `${r.id}: ${r.title} — ${r.company} (${r.start || "?"} – ${r.end || "present"})`);
    lines.push(`The candidate updated the interview forms. Timeline now: ${timeline.join("; ") || "no roles yet"}.`);
  }
  const b = (before.answers ?? []) as number[];
  const a = (after.answers ?? []) as number[];
  if (b.some((id) => !a.includes(id))) {
    const answers = scopeAnswers(ctx, interview, stage, experienceRef);
    lines.push(`The candidate edited or deleted answers in the review drawer. Recorded for this conversation now: ${stableStringify(compactAnswers(answers))}.`);
  }
  if (stableStringify(before.answers ?? []) !== stableStringify(after.answers ?? []) || stableStringify(before.covered ?? []) !== stableStringify(after.covered ?? [])) {
    lines.push(coverageLine(coverage(ctx, interview, stage, experienceRef)));
  }
  if (before.status !== after.status) {
    if (after.status === "skipped") lines.push("The candidate skipped this part; they may still add answers.");
    else if (after.status === "pending") lines.push("The candidate reopened this part. Continue with what is still missing, or ask what they want to add.");
    else if (after.status === "done") lines.push("This part is finished. Ask nothing more; they can press Continue, or Reopen to add more.");
  }
  return lines.length ? lines.join("\n") : null;
}

/** Starts the conversation for one stage (and role), freezing its system prompt, tools, model and context. */
export function createInterviewConversation(ctx: AiContext, interviewId: number, stage: ChatStage, experienceRef: string | null, now = new Date()): ConversationRow {
  const interview = getInterview(ctx.db, ctx.userId, interviewId);
  if (!interview) throw new UserFacingError("not_found");
  if (stage === "role_deep" && !interview.form.roles.some((r) => r.id === experienceRef)) throw new UserFacingError("not_found");
  const ref = stage === "role_deep" ? experienceRef : null;
  const { model, effort, connection } = resolveTaskModel(settingsFor(ctx), "cvInterview");
  const depth = stage === "role_deep" ? (interview.form.roles.find((r) => r.id === ref)?.depth ?? "deep") : null;
  return ctx.db.transaction((tx) => {
    const conversation = tx
      .insert(conversations)
      .values({
        userId: ctx.userId,
        jobId: null,
        kind: "cv_interview",
        model,
        effort,
        provider: connection,
        toolsetVersion: INTERVIEW_TOOLSET_VERSION,
        system: interviewSystem({
          language: interview.language,
          stage,
          depth,
          personas: interview.personas,
          today: now.toISOString().slice(0, 10),
          role: chatRole(interview, stage, ref),
          targetTitles: interview.form.target.titles,
        }),
        tools: interviewTools(),
        stateDigest: stableStringify(interviewDigest({ db: tx as unknown as AiContext["db"] }, interview, stage, ref, now)),
        updatedAt: now,
      })
      .returning()
      .get();
    tx.insert(chatMessages).values({ conversationId: conversation.id, seq: 0, role: "user", kind: "context", content: interviewContext(ctx, interview, stage, ref) }).run();
    linkConversation(tx as unknown as AiContext["db"], conversation.id, interview.id, stage, ref);
    return conversation;
  });
}

/**
 * The stage's conversation, created on first use. One started with an older interviewer (another
 * toolset version) is left as it is and a new one begins: its prompt and tools are frozen. Answers
 * belong to the interview, so nothing recorded is lost.
 */
export function ensureInterviewConversation(ctx: AiContext, interviewId: number, stage: ChatStage, experienceRef: string | null): ConversationRow {
  const ref = stage === "role_deep" ? experienceRef : null;
  const link = stageConversation(ctx.db, interviewId, stage, ref);
  const existing = link ? ctx.db.select().from(conversations).where(and(eq(conversations.id, link.conversationId), eq(conversations.userId, ctx.userId))).get() : undefined;
  return existing && existing.toolsetVersion === INTERVIEW_TOOLSET_VERSION ? existing : createInterviewConversation(ctx, interviewId, stage, ref);
}

// ---- The verbatim gate ----

const compact = (normalized: string) => normalized.replace(/[\s\-_]/g, "");
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** What the candidate typed in this conversation (never context blocks, context updates or the assistant's words). */
function candidateMessages(ctx: Pick<AiContext, "db">, conversationId: number): string[] {
  return ctx.db
    .select({ text: chatMessages.text })
    .from(chatMessages)
    .where(and(eq(chatMessages.conversationId, conversationId), eq(chatMessages.kind, "user")))
    .all()
    .map((r) => r.text ?? "")
    .filter(Boolean);
}

/** Like the CV checks: 3+ words, or 4+ Hangul characters. Anything shorter is useless as evidence. */
function substantial(quote: string): boolean {
  return quote.trim().split(/\s+/).length >= 3 || /[\p{Script=Hangul}]{4,}/u.test(quote);
}

export type GateResult = { ok: true; quote: string; message: string } | { ok: false; reason: "elided" | "too_short" | "punctuation" | "not_verbatim" };

/**
 * A quote is accepted only as a contiguous part of ONE message the candidate typed here (whitespace
 * may differ). No "…" elisions, no joining two messages, no paraphrase. The stored quote is the
 * whitespace-collapsed quote, which is then a substring of what they typed.
 */
export function verbatimGate(quote: string, messages: string[]): GateResult {
  const q = collapse(quote);
  if (/\.\.\.|…/.test(q)) return { ok: false, reason: "elided" };
  if (!substantial(q)) return { ok: false, reason: "too_short" };
  const message = messages.find((m) => collapse(m).includes(q));
  if (message) return { ok: true, quote: q, message };
  // Same words with different quote marks, dashes or case: still rejected, with a hint to copy exactly.
  const normalized = buildQuoteIndex(q).normalized;
  const near = messages.some((m) => {
    const index = buildQuoteIndex(m);
    return index.normalized.includes(normalized) || index.compacted.includes(compact(normalized));
  });
  return { ok: false, reason: near ? "punctuation" : "not_verbatim" };
}

const GATE_ERRORS: Record<Exclude<GateResult, { ok: true }>["reason"], string> = {
  elided: "Not recorded: the quote contains an ellipsis. Quote one contiguous part of one message instead.",
  too_short: "Not recorded: the quote is too short to be evidence (at least three words). Quote more of the candidate's message.",
  punctuation: "Not recorded: the words match but the punctuation or letter case differs. Copy the candidate's message character for character.",
  not_verbatim: "Not recorded: not verbatim. Quote the candidate's exact words from one message, character for character.",
};

function interviewScope(ctx: AiContext, conversation: ConversationRow): ChatScope {
  const link = interviewForConversation(ctx.db, conversation.id);
  if (!link) throw new UserFacingError("not_found");
  const load = () => {
    const interview = getInterview(ctx.db, ctx.userId, link.interviewId);
    if (!interview) throw new UserFacingError("not_found");
    return interview;
  };
  const stage = link.stage as InterviewStage;
  const ref = link.experienceRef;

  return {
    task: "cvInterview",
    digest: () => interviewDigest(ctx, load(), stage, ref),
    contextUpdate: (previous, digest) => describeInterviewChange(ctx, load(), previous, digest, stage, ref),
    async runTool(block, emit: (e: ChatEvent) => void, messageId): Promise<ToolResult> {
      const result = (content: string, isError = false): ToolResult => ({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
      if (!(block.name in inputSchemas)) return result(`Unknown tool ${block.name}`, true);
      const parsed = inputSchemas[block.name as keyof typeof inputSchemas].safeParse(block.input);
      if (!parsed.success) return result(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, true);
      const input = parsed.data as Record<string, unknown>;
      const interview = load();
      if (interview.status !== "in_progress") return result("This interview is finished; nothing more can be recorded.", true);

      switch (block.name) {
        case "record_answer": {
          // A quick reply ("Skip this question", "That's all for this part") is an instruction, never evidence.
          if (Object.values(CONTROL).some((re) => re.test(collapse(String(input.quote))))) return result("Not recorded: that is one of the quick replies, not an answer. Follow it instead.", true);
          const gate = verbatimGate(String(input.quote), candidateMessages(ctx, conversation.id));
          if (!gate.ok) return result(GATE_ERRORS[gate.reason], true);
          const answer = insertAnswer(ctx.db, {
            interviewId: interview.id,
            stage,
            topic: input.topic as InterviewTopic,
            experienceRef: answerExperienceRef(interview, stage, ref),
            question: String(input.question).slice(0, 1000),
            quote: gate.quote,
            private: Boolean(input.private),
            origin: "chat",
            messageId,
          });
          emit({ type: "tool", name: "record_answer", detail: gate.quote.slice(0, 120) });
          const { missing } = coverage(ctx, interview, stage, ref);
          return result(
            `Recorded #${answer.id}${answer.private ? " (private: never on the CV)" : ""}.${answer.private ? "" : " Offer a cleaner version with propose_polish if it needs one."} ${missing.length ? `Still needed: ${missing.join(", ")}.` : "All required topics covered."}`,
          );
        }
        case "propose_polish": {
          const answer = scopeAnswers(ctx, interview, stage, ref).find((a) => a.id === input.answer_id);
          if (!answer) return result(`No answer #${String(input.answer_id)} in this conversation.`, true);
          if (answer.private) return result("Private answers never reach the CV; no cleaner version needed.", true);
          const text = String(input.text).replace(/\s+/g, " ").trim();
          if (text === answer.quote) return result("That is the candidate's text unchanged; nothing to show. Ask the next question.", true);
          const waiting = ctx.db
            .select()
            .from(chatActions)
            .where(and(eq(chatActions.conversationId, conversation.id), eq(chatActions.kind, "interview_polish"), eq(chatActions.status, "pending")))
            .all()
            .some((a) => (a.payload as { answerId?: number }).answerId === answer.id);
          if (waiting) return result("A cleaner version of this answer is already waiting for the candidate.", true);
          const { current, roles } = interview.form;
          const gate = polishGate(answer.quote, text, { keep: [current.company, current.title, ...roles.flatMap((r) => [r.company, r.title])].filter(Boolean) });
          if (!gate.ok) return result(polishRefusal(gate), true);
          const action = ctx.db
            .insert(chatActions)
            .values({ conversationId: conversation.id, messageId, toolUseId: block.id, kind: "interview_polish", payload: { answerId: answer.id, raw: answer.quote, text } })
            .returning()
            .get();
          emit({ type: "card", actionId: action.id });
          return result("Shown to the candidate as a card; they accept it, edit it or keep their own words. Ask the next question now.");
        }
        case "suggest_options": {
          const options = [...new Set((input.options as string[]).map((o) => o.replace(/\s+/g, " ").trim()).filter(Boolean))];
          if (options.some((o) => /\d/.test(o))) return result("Not shown: examples may not contain digits (a figure must come from the candidate). Send them again without numbers.", true);
          emit({ type: "tool", name: "suggest_options", detail: options.join(" · ") });
          return result("Shown as examples under your question. End your turn now; write nothing more.");
        }
        case "record_skill": {
          const name = String(input.name).trim();
          if (!candidateMessages(ctx, conversation.id).some((m) => termPresent(m, name))) return result(`Not noted: "${name}" isn't in the candidate's messages. Only note skills they named.`, true);
          const skills = interview.form.skills;
          if (!skills.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
            const experienceRef = answerExperienceRef(interview, stage, ref);
            updateInterview(ctx.db, interview.id, { form: { ...interview.form, skills: [...skills, { name, category: input.category as (typeof SKILL_CATEGORIES)[number], experienceRef, ticked: false }] } });
          }
          emit({ type: "tool", name: "record_skill", detail: name });
          return result(`Noted ${name}; the candidate confirms skills in the review step.`);
        }
        case "list_answers": {
          const answers = scopeAnswers(ctx, interview, stage, ref);
          emit({ type: "tool", name: "list_answers", detail: null });
          return result(answers.length ? stableStringify(compactAnswers(answers), 1) : "Nothing recorded in this conversation yet.");
        }
        case "complete_stage": {
          const key = stageKey(stage, ref);
          if (interview.stages[key] === "done") return result("Already finished. Ask nothing more; tell the candidate to press Continue, or Reopen to add more.");
          const { missing } = coverage(ctx, interview, stage, ref);
          if (input.reason === "covered" && missing.length) {
            return result(`Not finished: still nothing recorded for ${missing.join(", ")}. Ask about ${missing.length > 1 ? "them" : "it"} (or the candidate can say that's all for this part).`, true);
          }
          setStageStatus(ctx.db, interview, key, "done");
          emit({ type: "tool", name: "complete_stage", detail: null });
          return result("This part is marked done. Thank the candidate briefly; the app moves them on to the next step.");
        }
      }
      return result(`Unknown tool ${block.name}`, true);
    },
  };
}

registerChatScope("cv_interview", interviewScope);
