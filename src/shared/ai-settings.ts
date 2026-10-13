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
  "searchAgent",
  "browserAgent",
  "companyResearch",
  "planTailoring",
  "tailorCv",
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
  searchAgent: "medium",
  browserAgent: "medium",
  companyResearch: "medium",
  planTailoring: "medium",
  tailorCv: "high",
  parseSearch: "low",
  translate: "low",
};

const modelSchema = z.enum(MODEL_IDS);
const effortSchema = z.enum(EFFORT_LEVELS);

export const taskSettingSchema = z.object({
  /** null = use the default model. */
  model: modelSchema.nullable(),
  effort: effortSchema,
});
export type TaskSetting = z.infer<typeof taskSettingSchema>;

export const aiSettingsSchema = z.object({
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

export function defaultAiSettings(defaultModel: ModelId = DEFAULT_MODEL): AiSettings {
  return {
    defaultModel,
    tasks: Object.fromEntries(
      AI_TASKS.map((task) => [task, { model: null, effort: DEFAULT_TASK_EFFORT[task] }]),
    ) as Record<AiTask, TaskSetting>,
    budget: { dailyUsd: 5, monthlyUsd: null, warnAtPercent: 80 },
    search: { screenTopN: 30, deepTopN: 5 },
  };
}

/**
 * Accepts a stored (possibly older or partial) settings object and fills anything missing
 * from the defaults, so adding a task later never breaks saved settings.
 */
export function normalizeAiSettings(raw: unknown, fallbackModel: ModelId = DEFAULT_MODEL): AiSettings {
  const base = defaultAiSettings(fallbackModel);
  if (!raw || typeof raw !== "object") return base;
  const input = raw as Partial<AiSettings>;
  const merged = {
    defaultModel: input.defaultModel ?? base.defaultModel,
    tasks: { ...base.tasks, ...(input.tasks ?? {}) },
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

export function resolveTaskModel(settings: AiSettings, task: AiTask): { model: ModelId; effort: Effort } {
  const entry = settings.tasks[task];
  return { model: entry.model ?? settings.defaultModel, effort: entry.effort };
}
