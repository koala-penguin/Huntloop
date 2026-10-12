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
