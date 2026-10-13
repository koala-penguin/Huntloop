import path from "node:path";
import { z } from "zod";
import { DEFAULT_MODEL, MODEL_IDS, type ModelId } from "@/shared/models";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  /** fake = demo mode everywhere; live = assume the API key works; claude-code = assume the Claude Code CLI is signed in. */
  HUNTLOOP_AI: z.enum(["live", "fake", "claude-code"]).optional(),
  /** Path to the Claude Code CLI (default: `claude` on PATH). */
  HUNTLOOP_CLAUDE_PATH: z.string().optional(),
  /** Where the Claude Code CLI reaches Huntloop's tool endpoint (default: http://127.0.0.1:$PORT). */
  HUNTLOOP_ORIGIN: z.string().url().optional(),
  HUNTLOOP_DEFAULT_MODEL: z.enum(MODEL_IDS).optional(),
  HUNTLOOP_DATA_DIR: z.string().optional(),
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  JSEARCH_API_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function readEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const cleaned = Object.fromEntries(
    Object.entries(source).map(([k, v]) => [k, v === "" ? undefined : v]),
  );
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ readEnv().HUNTLOOP_DATA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data"));
}

/** The API connection: live calls need a key; without one (or with HUNTLOOP_AI=fake) responses are simulated. */
export function aiMode(env: Env = readEnv()): "live" | "fake" {
  if (env.HUNTLOOP_AI === "fake") return "fake";
  if (env.HUNTLOOP_AI === "live") return "live";
  return env.ANTHROPIC_API_KEY ? "live" : "fake";
}

export function envDefaultModel(env: Env = readEnv()): ModelId {
  return env.HUNTLOOP_DEFAULT_MODEL ?? DEFAULT_MODEL;
}
