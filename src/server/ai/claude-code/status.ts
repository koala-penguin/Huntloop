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
  return readEnv().HUNTLOOP_CLAUDE_PATH;
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
  /** When a negative status stops being trusted (set when its check finished). */
  expiresAt?: number;
  /** Consecutive negative answers; each doubles the time until the next check. */
  failures?: number;
  /** Test hook replacing the real `claude` checks. */
  checker?: (() => Promise<ClaudeCodeStatus>) | null;
}

/** A "not found / signed out" answer is re-checked after this long, doubling up to the max. */
export const NEGATIVE_STATUS_TTL_MS = 60_000;
export const NEGATIVE_STATUS_MAX_TTL_MS = 10 * 60_000;

const state = ((globalThis as unknown as { huntloopClaudeCode?: StatusState }).huntloopClaudeCode ??= {});

export function subscriptionReady(status: ClaudeCodeStatus | null = cachedClaudeCodeStatus()): boolean {
  return !!status?.found && status.loggedIn;
}

function negativeTtl(failures: number): number {
  return Math.min(NEGATIVE_STATUS_TTL_MS * 2 ** Math.max(0, failures - 1), NEGATIVE_STATUS_MAX_TTL_MS);
}

function remember(status: ClaudeCodeStatus): ClaudeCodeStatus {
  state.status = status;
  if (subscriptionReady(status)) {
    state.failures = 0;
    state.expiresAt = undefined;
  } else {
    state.failures = (state.failures ?? 0) + 1;
    // Counted from when the check finished, not when it started (a slow check mustn't eat the wait).
    state.expiresAt = Date.now() + negativeTtl(state.failures);
  }
  return status;
}

/** A negative status whose wait is over (the next `getClaudeCodeStatus()` asks the CLI again). */
export function claudeCodeStatusExpired(): boolean {
  return !!state.status && !subscriptionReady(state.status) && (state.expiresAt === undefined || Date.now() >= state.expiresAt);
}

/**
 * The CLI's status. A signed-in answer is kept for the process; a negative one only until it
 * expires (1 min, doubling on each further negative answer up to 10 min). `refresh` asks at once
 * and resets the backoff (Settings → "Check again"). Concurrent calls share one check.
 */
export function getClaudeCodeStatus(options: { refresh?: boolean } = {}): Promise<ClaudeCodeStatus> {
  if (options.refresh) state.failures = 0;
  else if (state.status && !claudeCodeStatusExpired()) return Promise.resolve(state.status);
  state.pending ??= (state.checker ?? check)()
    .then(remember)
    .finally(() => (state.pending = undefined));
  return state.pending;
}

export function cachedClaudeCodeStatus(): ClaudeCodeStatus | null {
  return state.status ?? null;
}

/** A run failed because the CLI isn't signed in (any more): stop treating it as ready. */
export function markSignedOut(error?: string): void {
  const previous = state.status ?? { found: true, version: null, loggedIn: false, authMethod: null, checkedAt: new Date(), error: null };
  state.status = { ...previous, loggedIn: false, checkedAt: new Date(), error: error ?? null };
  // Many runs failing together keep the current backoff rather than resetting it to 1 min.
  state.failures = Math.max(state.failures ?? 0, 1);
  state.expiresAt = Date.now() + negativeTtl(state.failures);
}

/** For tests. */
export function setClaudeCodeStatus(status: ClaudeCodeStatus | null): void {
  state.status = status ?? undefined;
  state.failures = status && !subscriptionReady(status) ? 1 : 0;
  state.expiresAt = status && !subscriptionReady(status) ? Date.now() + NEGATIVE_STATUS_TTL_MS : undefined;
}

/** For tests: replace the real `claude --version` / `auth status` checks (null restores them). */
export function setClaudeCodeChecker(fn: (() => Promise<ClaudeCodeStatus>) | null): void {
  state.checker = fn;
}

/**
 * Until the user picks a connection: their subscription when the Claude Code CLI is installed
 * (signed in or not — signed out shows "AI work is paused" instead of quietly using demo output),
 * else the API connection.
 */
export function defaultConnection(): Connection {
  return state.status?.found ? "subscription" : "api";
}

/** "api_key"-style sign-ins bill the Console account per token rather than using the plan's limits. */
export function isConsoleSignIn(authMethod: string | null): boolean {
  return !!authMethod && /api[_ -]?key|console/i.test(authMethod);
}
