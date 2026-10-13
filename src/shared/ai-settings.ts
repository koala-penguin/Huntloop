import { z } from "zod";
import { DEFAULT_MODEL, EFFORT_LEVELS, MODEL_IDS, type Effort, type ModelId } from "./models";

/** Every kind of Claude call Huntloop makes. Each can use its own model and effort. */
export const AI_TASKS = [
  "extractProfile",
  "transcribePosting",
  "analyzePosting",
  "assess",
  "screen",
  "chat",
  "coach",
  "searchAgent",
  "browserAgent",
  "companyResearch",
  "planTailoring",
  "tailorCv",
  "linkedinProfile",
  "parseSearch",
  "translate",
] as const;
export type AiTask = (typeof AI_TASKS)[number];

export const DEFAULT_TASK_EFFORT: Record<AiTask, Effort> = {
  extractProfile: "high",
  transcribePosting: "low",
  analyzePosting: "medium",
  assess: "medium",
  screen: "low",
  chat: "medium",
  coach: "medium",
  searchAgent: "medium",
  browserAgent: "medium",
  companyResearch: "medium",
  planTailoring: "medium",
  tailorCv: "high",
  linkedinProfile: "medium",
  parseSearch: "low",
  translate: "low",
};

/**
 * How Claude is reached: the Anthropic API with an API key (billed per token), or the user's own
 * Claude subscription through their signed-in Claude Code CLI (`claude -p`, counts against the
 * plan's usage limits). Each has its own settings profile; the user switches between them.
 */
export const CONNECTIONS = ["api", "subscription"] as const;
export type Connection = (typeof CONNECTIONS)[number];
/** Per task: follow the profile's connection, or always use one of them. */
export const TASK_CONNECTIONS = ["profile", ...CONNECTIONS] as const;
export type TaskConnection = (typeof TASK_CONNECTIONS)[number];

const modelSchema = z.enum(MODEL_IDS);
const effortSchema = z.enum(EFFORT_LEVELS);
const connectionSchema = z.enum(CONNECTIONS);

export const taskSettingSchema = z.object({
  /** null = use the default model. */
  model: modelSchema.nullable(),
  effort: effortSchema,
  connection: z.enum(TASK_CONNECTIONS).default("profile"),
});
export type TaskSetting = z.infer<typeof taskSettingSchema>;

/** One settings profile. `connection` says which connection it belongs to. */
export const aiSettingsSchema = z.object({
  connection: connectionSchema.default("api"),
  defaultModel: modelSchema,
  tasks: z.object(
    Object.fromEntries(AI_TASKS.map((task) => [task, taskSettingSchema])) as Record<
      AiTask,
      typeof taskSettingSchema
    >,
  ),
  budget: z.object({
    dailyUsd: z.number().min(0),
    monthlyUsd: z.number().min(0).nullable(),
    warnAtPercent: z.number().int().min(1).max(100),
  }),
  search: z.object({
    screenTopN: z.number().int().min(0).max(200),
    deepTopN: z.number().int().min(0).max(50),
  }),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;

export function defaultAiSettings(defaultModel: ModelId = DEFAULT_MODEL, connection: Connection = "api"): AiSettings {
  return {
    connection,
    defaultModel,
    tasks: Object.fromEntries(
      AI_TASKS.map((task) => [task, { model: null, effort: DEFAULT_TASK_EFFORT[task], connection: "profile" }]),
    ) as Record<AiTask, TaskSetting>,
    budget: { dailyUsd: 5, monthlyUsd: null, warnAtPercent: 80 },
    search: { screenTopN: 30, deepTopN: 5 },
  };
}

/**
 * Accepts a stored (possibly older or partial) settings object and fills anything missing
 * from the defaults, so adding a task later never breaks saved settings.
 */
export function normalizeAiSettings(raw: unknown, fallbackModel: ModelId = DEFAULT_MODEL, connection?: Connection): AiSettings {
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<AiSettings>;
  const profile = connection ?? (connectionSchema.safeParse(input.connection).data ?? "api");
  const base = defaultAiSettings(fallbackModel, profile);
  if (!raw || typeof raw !== "object") return base;
  const storedTasks = (input.tasks ?? {}) as Record<string, unknown>;
  const merged = {
    connection: profile,
    defaultModel: input.defaultModel ?? base.defaultModel,
    // Entries saved before a field existed get it from the defaults.
    tasks: Object.fromEntries(
      AI_TASKS.map((task) => {
        const stored = storedTasks[task];
        return [task, stored && typeof stored === "object" ? { ...base.tasks[task], ...stored } : base.tasks[task]];
      }),
    ),
    budget: { ...base.budget, ...(input.budget ?? {}) },
    search: { ...base.search, ...(input.search ?? {}) },
  };
  const parsed = aiSettingsSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Keep whatever individual task entries are still valid.
  const tasks = { ...base.tasks };
  for (const task of AI_TASKS) {
    const entry = taskSettingSchema.safeParse((input.tasks as Record<string, unknown> | undefined)?.[task]);
    if (entry.success) tasks[task] = entry.data;
  }
  const defaultModel = modelSchema.safeParse(input.defaultModel);
  return { ...base, defaultModel: defaultModel.success ? defaultModel.data : base.defaultModel, tasks };
}

export function resolveTaskModel(settings: AiSettings, task: AiTask): { connection: Connection; model: ModelId; effort: Effort } {
  const entry = settings.tasks[task];
  return {
    connection: entry.connection === "profile" ? settings.connection : entry.connection,
    model: entry.model ?? settings.defaultModel,
    effort: entry.effort,
  };
}

/** Both profiles and which one is in use. This is what Settings stores. */
export const aiConfigSchema = z.object({
  active: connectionSchema,
  profiles: z.object({ api: aiSettingsSchema, subscription: aiSettingsSchema }),
});
export type AiConfig = z.infer<typeof aiConfigSchema>;

export function defaultAiConfig(defaultModel: ModelId = DEFAULT_MODEL, active: Connection = "api"): AiConfig {
  return { active, profiles: { api: defaultAiSettings(defaultModel, "api"), subscription: defaultAiSettings(defaultModel, "subscription") } };
}

/**
 * Accepts what was stored: the current shape, or the single profile saved before connections
 * existed (it becomes both profiles, so nothing the user chose is lost).
 */
export function normalizeAiConfig(raw: unknown, fallbackModel: ModelId = DEFAULT_MODEL, defaultActive: Connection = "api"): AiConfig {
  if (!raw || typeof raw !== "object") return defaultAiConfig(fallbackModel, defaultActive);
  const input = raw as { active?: unknown; profiles?: { api?: unknown; subscription?: unknown } };
  if (!input.profiles || typeof input.profiles !== "object") {
    const legacy = normalizeAiSettings(raw, fallbackModel, "api");
    return { active: defaultActive, profiles: { api: legacy, subscription: { ...legacy, connection: "subscription" } } };
  }
  const api = normalizeAiSettings(input.profiles.api, fallbackModel, "api");
  const subscription = input.profiles.subscription ? normalizeAiSettings(input.profiles.subscription, fallbackModel, "subscription") : { ...api, connection: "subscription" as const };
  return { active: connectionSchema.safeParse(input.active).data ?? defaultActive, profiles: { api, subscription } };
}
