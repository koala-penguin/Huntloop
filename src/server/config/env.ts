import path from "node:path";
import { z } from "zod";
import { DEFAULT_MODEL, MODEL_IDS, type ModelId } from "@/shared/models";

const envSchema = z.object({
  ANTHROPIC_API_KEY: z.string().optional(),
  /** fake = demo mode everywhere; live = assume the API key works; claude-code = assume the Claude Code CLI is signed in. */
  HUNTLOOP_AI: z.enum(["live", "fake", "claude-code"]).optional(),
  /** Path to the Claude Code CLI (default: `claude` on PATH). */
  HUNTLOOP_CLAUDE_PATH: z.string().default("claude"),
  /** Where the Claude Code CLI reaches Huntloop's tool endpoint (default: http://127.0.0.1:$PORT). */
  HUNTLOOP_ORIGIN: z.string().url().optional(),
  /** Extra hosts the app answers for (comma-separated host[:port]); loopback and HUNTLOOP_ORIGIN's host always are. */
  HUNTLOOP_ALLOWED_HOSTS: z.string().optional(),
  HUNTLOOP_DEFAULT_MODEL: z.enum(MODEL_IDS).optional(),
  HUNTLOOP_DATA_DIR: z.string().optional(),
  ADZUNA_APP_ID: z.string().optional(),
  ADZUNA_APP_KEY: z.string().optional(),
  /** Discord webhook for CAPTCHA / sign-in alerts. Checked where it's used, so a typo never breaks the app. */
  HUNTLOOP_DISCORD_WEBHOOK: z.string().optional(),
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

function dataDir(): string {
  return path.resolve(/*turbopackIgnore: true*/ readEnv().HUNTLOOP_DATA_DIR ?? path.join(/*turbopackIgnore: true*/ process.cwd(), "data"));
}

/**
 * A path inside the data directory. Always build data paths here: a literal segment joined at a
 * call site (`path.join(dataDir(), "browser-profile")`) makes Turbopack look that folder up at
 * build time and read it, and `next build` then fails on the dangling SingletonLock and
 * RunningChromeVersion symlinks Chrome leaves in data/browser-profile.
 */
export function dataPath(...segments: string[]): string {
  return path.join(dataDir(), ...segments);
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
