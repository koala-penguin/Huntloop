import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  locale: text("locale").notNull().default("en"),
  /** Language the AI writes explanations in; null = follow the UI language. */
  aiLanguage: text("ai_language"),
  createdAt: createdAt(),
});

export const appSettings = sqliteTable("app_settings", {
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  key: text("key").notNull(),
  value: text("value", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.key] })]);

export const usageLog = sqliteTable(
  "usage_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    task: text("task").notNull(),
    model: text("model").notNull(),
    servedModel: text("served_model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    webSearches: integer("web_searches").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    simulated: integer("simulated", { mode: "boolean" }).notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [index("usage_log_created").on(t.createdAt)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    /** queued | running | needs_user_action | succeeded | failed | cancelled */
    status: text("status").notNull().default("queued"),
    payload: text("payload", { mode: "json" }).$type<unknown>(),
    progress: text("progress", { mode: "json" }).$type<unknown>(),
    result: text("result", { mode: "json" }).$type<unknown>(),
    error: text("error"),
    attempts: integer("attempts").notNull().default(0),
    parentId: integer("parent_id"),
    heartbeatAt: integer("heartbeat_at", { mode: "timestamp_ms" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("tasks_status").on(t.status, t.createdAt)],
);

export type TaskRow = typeof tasks.$inferSelect;

/** Append-only: every edit or new CV creates a new version, so analyses stay tied to what they saw. */
export const profileVersions = sqliteTable(
  "profile_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    version: integer("version").notNull(),
    cvFileName: text("cv_file_name"),
    cvFilePath: text("cv_file_path"),
    /** Canonical CV text — every evidence quote is checked against it. */
    cvText: text("cv_text").notNull(),
    data: text("data", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("profile_versions_user_version").on(t.userId, t.version)],
);

export const preferences = sqliteTable("preferences", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id),
  data: text("data", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const companies = sqliteTable(
  "companies",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    domain: text("domain"),
    atsType: text("ats_type"),
    atsSlug: text("ats_slug"),
    country: text("country"),
    createdAt: createdAt(),
  },
  (t) => [index("companies_user_name").on(t.userId, t.normalizedName)],
);

export interface JobIntake {
  hints?: Record<string, string | null>;
  /** The text may contain page noise around the posting (pastes, readable-text extraction). */
  noisy?: boolean;
  /** Why the app couldn't read the posting itself (needs_content). */
  reason?: string;
  site?: string | null;
  illegible?: string[];
}

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    companyId: integer("company_id").references(() => companies.id),
    source: text("source").notNull(),
    sourceUrl: text("source_url"),
    applyUrl: text("apply_url"),
    title: text("title"),
    companyName: text("company_name"),
    locationText: text("location_text"),
    city: text("city"),
    country: text("country"),
    workplace: text("workplace"),
    employmentType: text("employment_type"),
    postedAt: integer("posted_at", { mode: "timestamp_ms" }),
    closesAt: integer("closes_at", { mode: "timestamp_ms" }),
    /** Raw input before cleaning (paste, fetched page text). */
    rawText: text("raw_text"),
    /** Canonical posting text — every posting quote is checked against it. */
    description: text("description"),
    descriptionIsFull: integer("description_is_full", { mode: "boolean" }).notNull().default(true),
    descriptionHash: text("description_hash"),
    /** processing | needs_content | ready | failed */
    intakeStatus: text("intake_status").notNull().default("processing"),
    intakeError: text("intake_error"),
    /** How the content was obtained: structured hints, noise flag, why more content is needed. */
    intake: text("intake", { mode: "json" }).$type<JobIntake>(),
    analysisId: integer("analysis_id"),
    assessmentId: integer("assessment_id"),
    /** User answers to Yes/No questions: { [requirementId]: "yes" | "no" } */
    answers: text("answers", { mode: "json" }).$type<Record<string, "yes" | "no">>(),
    status: text("status").notNull().default("new"),
    score: real("score"),
    tier: text("tier"),
    eligibility: text("eligibility"),
    confidence: text("confidence"),
    scoreData: text("score_data", { mode: "json" }),
    notes: text("notes"),
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("jobs_user_status").on(t.userId, t.status), index("jobs_user_dedupe").on(t.userId, t.dedupeKey)],
);
export type JobRow = typeof jobs.$inferSelect;

export const jobAttachments = sqliteTable("job_attachments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  path: text("path").notNull(),
  mime: text("mime").notNull(),
  fileName: text("file_name"),
  sort: integer("sort").notNull().default(0),
  createdAt: createdAt(),
});

export const jobEvents = sqliteTable("job_events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobs.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  fromValue: text("from_value"),
  toValue: text("to_value"),
  note: text("note"),
  createdAt: createdAt(),
});

/** Profile-independent posting analysis, cached by posting text hash + prompt version + model. */
export const postingAnalyses = sqliteTable(
  "posting_analyses",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    textHash: text("text_hash").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    data: text("data", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("posting_analyses_key").on(t.textHash, t.promptVersion, t.model)],
);

/**
 * Profile × posting assessment, cached by analysis + profile content hash + prompt version + model + effort.
 * The hash covers only what the assessment reads (CV text, experience, skills, facts…), so answering a
 * work-rights question creates a new profile version without invalidating assessments.
 */
export const assessments = sqliteTable(
  "assessments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    analysisId: integer("analysis_id")
      .notNull()
      .references(() => postingAnalyses.id),
    profileVersion: integer("profile_version").notNull(),
    profileHash: text("profile_hash").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    kind: text("kind").notNull().default("deep"),
    language: text("language").notNull(),
    data: text("data", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("assessments_key").on(t.analysisId, t.profileHash, t.promptVersion, t.model, t.effort, t.kind)],
);

/** AI-written prose translated into another language (owner = e.g. an assessment). */
export const aiTexts = sqliteTable(
  "ai_texts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    ownerType: text("owner_type").notNull(),
    ownerId: integer("owner_id").notNull(),
    lang: text("lang").notNull(),
    data: text("data", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("ai_texts_owner").on(t.ownerType, t.ownerId, t.lang)],
);

/**
 * A chat about one job. Its system prompt, tools, model and effort are frozen at creation so every
 * request is a strict extension of the previous one (prompt caching, preserved thinking).
 */
export const conversations = sqliteTable(
  "conversations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    jobId: integer("job_id").references(() => jobs.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("job"),
    model: text("model").notNull(),
    effort: text("effort").notNull(),
    toolsetVersion: integer("toolset_version").notNull(),
    system: text("system").notNull(),
    /** Tool definitions as first sent (part of the cached prefix). */
    tools: text("tools", { mode: "json" }).notNull(),
    /** Snapshot of the job state last told to the model; a change is sent as a context update. */
    stateDigest: text("state_digest"),
    createdAt: createdAt(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("conversations_job").on(t.userId, t.jobId)],
);
export type ConversationRow = typeof conversations.$inferSelect;

/** Messages exactly as sent to / received from the API (content blocks verbatim, in order). */
export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationId: integer("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    /** context | user | tool_results | assistant */
    kind: text("kind").notNull(),
    content: text("content", { mode: "json" }).notNull(),
    /** What the user typed (user rows), for display. */
    text: text("text"),
    stopReason: text("stop_reason"),
    servedModel: text("served_model"),
    usage: text("usage", { mode: "json" }),
    createdAt: createdAt(),
  },
  (t) => [index("chat_messages_conversation").on(t.conversationId, t.seq)],
);
export type ChatMessageRow = typeof chatMessages.$inferSelect;

/** Things the AI proposed that only the user's click can apply (profile facts, proceeding). */
export const chatActions = sqliteTable("chat_actions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  messageId: integer("message_id"),
  toolUseId: text("tool_use_id").notNull(),
  kind: text("kind").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  /** pending | accepted | dismissed */
  status: text("status").notNull().default("pending"),
  createdAt: createdAt(),
  resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
});
export type ChatActionRow = typeof chatActions.$inferSelect;
