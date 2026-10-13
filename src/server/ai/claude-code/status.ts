import { execFile } from "node:child_process";
import type { Connection } from "@/shared/ai-settings";
import { readEnv } from "../../config/env";

/**
 * The user's own Claude Code CLI, used for the "Claude subscription" connection. Huntloop only runs
 * the unmodified `claude` binary the user signed in to (`claude auth login`, Anthropic's own flow);
 * it never reads, stores or forwards credentials. All it keeps is whether the CLI is signed in.
 */
export interface ClaudeCodeStatus {
  found: boolean;
  version: string | null;
  loggedIn: boolean;
  /** How the CLI is signed in, as `claude auth status` names it (e.g. "claude.ai", "oauth_token", "api_key"). */
  authMethod: string | null;
  checkedAt: Date;
  error: string | null;
}

export function claudeBinary(): string {
  return readEnv().HUNTLOOP_CLAUDE_PATH ?? "claude";
}

/**
 * Variables that would make the CLI use Huntloop's API key instead of the user's subscription, or
 * attach it to a Claude Code session Huntloop itself might be running inside.
 */
const STRIPPED_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDECODE|CLAUDE_PID|CLAUDE_AFTER_LAST_COMPACT|CLAUDE_EFFORT|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_(SESSION_ID|REMOTE_SESSION_ID|CHILD_SESSION|MESSAGING_SOCKET|MESSAGING_TOKEN|SESSION_ATTENDED|WORKER_EPOCH|TEE_SDK_STDOUT|DIAGNOSTICS_FILE|SYNC_SESSION_REFS))$/;

export function cliEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) => !STRIPPED_ENV.test(key))) as NodeJS.ProcessEnv;
}

function run(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(claudeBinary(), args, { env: cliEnv(), timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) reject(Object.assign(error, { stdout: String(stdout ?? "") }));
      else resolve(String(stdout));
    });
  });
}

function parseAuth(text: string): { loggedIn: boolean; authMethod: string | null } | null {
  try {
    const auth = JSON.parse(text) as { loggedIn?: unknown; authMethod?: unknown };
    return { loggedIn: auth.loggedIn === true, authMethod: typeof auth.authMethod === "string" && auth.authMethod !== "none" ? auth.authMethod : null };
  } catch {
    return null;
  }
}

async function check(): Promise<ClaudeCodeStatus> {
  const checkedAt = new Date();
  let version: string | null;
  try {
    version = (await run(["--version"], 15_000)).trim().split(/\s+/)[0] || null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { found: false, version: null, loggedIn: false, authMethod: null, checkedAt, error: code === "ENOENT" ? null : (error as Error).message };
  }
  try {
    const auth = parseAuth(await run(["auth", "status", "--json"], 20_000));
    return { found: true, version, loggedIn: auth?.loggedIn ?? false, authMethod: auth?.authMethod ?? null, checkedAt, error: auth ? null : "unreadable status" };
  } catch (error) {
    // Signed out exits non-zero but still prints the JSON status.
    const auth = parseAuth((error as { stdout?: string }).stdout ?? "");
    return { found: true, version, loggedIn: auth?.loggedIn ?? false, authMethod: auth?.authMethod ?? null, checkedAt, error: auth ? null : (error as Error).message };
  }
}

interface StatusState {
  status?: ClaudeCodeStatus;
  pending?: Promise<ClaudeCodeStatus>;
}

const state = ((globalThis as unknown as { huntloopClaudeCode?: StatusState }).huntloopClaudeCode ??= {});

/** Checks the CLI once and caches the answer; `refresh` asks again (Settings → "Check again"). */
export function getClaudeCodeStatus(options: { refresh?: boolean } = {}): Promise<ClaudeCodeStatus> {
  if (state.status && !options.refresh) return Promise.resolve(state.status);
  state.pending ??= check()
    .then((status) => (state.status = status))
    .finally(() => (state.pending = undefined));
  return state.pending;
}

export function cachedClaudeCodeStatus(): ClaudeCodeStatus | null {
  return state.status ?? null;
}

/** For tests. */
export function setClaudeCodeStatus(status: ClaudeCodeStatus | null): void {
  state.status = status ?? undefined;
}

/** Until the user picks a connection: their subscription when the CLI is signed in, else the API. */
export function defaultConnection(): Connection {
  return state.status?.loggedIn ? "subscription" : "api";
}

/** "api_key"-style sign-ins bill the Console account per token rather than using the plan's limits. */
export function isConsoleSignIn(authMethod: string | null): boolean {
  return !!authMethod && /api[_ -]?key|console/i.test(authMethod);
}
