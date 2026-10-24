import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { AiError } from "../errors";
import { claudeBinary, cliEnv } from "./status";
import { recordLimitReached, recordRateLimit, subscriptionLimitedUntil } from "./limits";

/**
 * Runs the user's Claude Code CLI in print mode (`claude -p`) with stream-json in and out. Every
 * run is isolated: an empty working directory, no settings or MCP servers but the ones given, only
 * the built-in tools a call needs, no permission prompts, and the user's own sign-in.
 */

export type CliEvent = Record<string, unknown> & { type: string; subtype?: string };

export interface CliRunOptions {
  model: string;
  effort: string;
  systemPrompt: string;
  /** Content blocks of the one user message sent on stdin (text, image, document). */
  input: unknown[];
  /** Built-in Claude Code tools the run may use, e.g. ["WebSearch"]; [] for none. */
  tools: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  /** JSON Schema for the final answer (`structured_output`). */
  jsonSchema?: object;
  maxTurns?: number;
  /** MCP servers (written to a private temp file, never on the command line). */
  mcpServers?: Record<string, unknown>;
  /** Chat threads: start a CLI session, or continue one as a fork (so a failed turn leaves it as it was). */
  session?: { mode: "new" | "resume"; id: string };
  partialMessages?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: CliEvent) => void;
  /**
   * Called once the run holds one of the CLI slots, with a function that gives the slot to other
   * runs while `fn` runs (e.g. while the browser agent waits for the user) and takes it back after.
   */
  onSlot?: (yieldSlot: <T>(fn: () => Promise<T>) => Promise<T>) => void;
}

export interface CliRunResult {
  result: CliEvent;
  /** `assistant` and `user` events, in order. */
  messages: CliEvent[];
  sessionId: string | null;
}

/** What a spawned CLI looks like to the runner (a ChildProcess, or a fake in tests). */
export interface CliProcess {
  stdin: Writable | null;
  stdout: Readable | null;
  stderr: Readable | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

export type CliSpawner = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => CliProcess;

const defaultSpawner: CliSpawner = (command, args, options) => spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });

interface RunnerState {
  spawner: CliSpawner;
  active: number;
  queue: Array<() => void>;
}

const state = ((globalThis as unknown as { huntloopCli?: RunnerState }).huntloopCli ??= { spawner: defaultSpawner, active: 0, queue: [] });

/** For tests: replace how the CLI is started (null restores the real one). */
export function setCliSpawner(spawner: CliSpawner | null): void {
  state.spawner = spawner ?? defaultSpawner;
}

/** At most this many CLI processes at once; the rest wait their turn. */
const MAX_CONCURRENT = 2;
const RUN_TIMEOUT_MS = 20 * 60_000;

function acquire(): Promise<void> {
  return new Promise((resolve) => {
    const go = () => {
      state.active++;
      resolve();
    };
    if (state.active < MAX_CONCURRENT) go();
    else state.queue.push(go);
  });
}

function release(): void {
  state.active--;
  state.queue.shift()?.();
}

/**
 * The CLI's working directory: one fixed folder outside Huntloop's own tree (the default data
 * folder sits inside the repo, where the CLI would read CLAUDE.md / AGENTS.md as project
 * instructions — checked with Claude Code 2.1.310). Fixed, not per run: chat sessions are found by
 * it. The CLI reads `<cwd>/.claude/settings.json` (--setting-sources project), and the system temp
 * folder can be shared between users (Linux /tmp), so the folder must be ours and private.
 */
export function workDir(): string {
  const dir = path.join(os.tmpdir(), "huntloop-claude-code");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const refuse = () => new AiError("api", `Claude Code's working folder isn't private: ${dir}`);
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw refuse();
  if (typeof process.getuid === "function" && (st.uid !== process.getuid() || (st.mode & 0o022) !== 0)) throw refuse();
  // Huntloop never creates these; if they exist, someone else put them there.
  if (fs.existsSync(path.join(dir, ".claude")) || fs.existsSync(path.join(dir, "CLAUDE.md"))) throw refuse();
  return dir;
}

export function buildCliArgs(options: CliRunOptions, files: { systemPrompt: string; mcpConfig: string | null }): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--model",
    options.model,
    "--effort",
    options.effort,
    "--system-prompt-file",
    files.systemPrompt,
    "--tools",
    options.tools.join(","),
    "--setting-sources",
    "project",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--permission-prompts",
    "none",
  ];
  if (options.partialMessages) args.push("--include-partial-messages");
  if (options.allowedTools?.length) args.push("--allowedTools", options.allowedTools.join(","));
  if (options.disallowedTools?.length) args.push("--disallowedTools", options.disallowedTools.join(","));
  if (options.jsonSchema) args.push("--json-schema", JSON.stringify(options.jsonSchema));
  if (options.maxTurns) args.push("--max-turns", String(options.maxTurns));
  if (files.mcpConfig) args.push("--mcp-config", files.mcpConfig);
  if (!options.session) args.push("--no-session-persistence");
  else if (options.session.mode === "new") args.push("--session-id", options.session.id);
  else args.push("--resume", options.session.id, "--fork-session");
  return args;
}

function resultText(result: CliEvent | null, stderr: string): string {
  const parts: string[] = [];
  if (typeof result?.result === "string") parts.push(result.result);
  if (Array.isArray(result?.errors)) parts.push(...(result.errors as unknown[]).map(String));
  if (stderr.trim()) parts.push(stderr.trim().split("\n").slice(-5).join("\n"));
  return parts.join("\n").trim();
}

/** Turns a failed run into an AiError the UI can explain. */
export function cliFailure(result: CliEvent | null, stderr: string, lastRetryError: string | null): AiError {
  const text = resultText(result, stderr);
  // Only a limit that hasn't reset yet; an old "rejected" state must not mislabel other failures.
  const limited = subscriptionLimitedUntil() !== null;
  if (limited || lastRetryError === "rate_limit" || /usage limit|limit reached|rate.?limit|out of (extra )?usage|weekly limit/i.test(text)) {
    const epoch = /\|(\d{9,})\b/.exec(text)?.[1];
    const resetsAt = epoch ? new Date(Number(epoch) * 1000) : subscriptionLimitedUntil();
    recordLimitReached(resetsAt);
    return new AiError("subscription_limit", "Claude subscription usage limit reached", { resetsAt: resetsAt?.toISOString() ?? null });
  }
  if (lastRetryError === "authentication_failed" || lastRetryError === "oauth_org_not_allowed" || /not logged in|please run \/login|\/login|authenticat|unauthori[sz]ed|invalid api key|oauth token/i.test(text)) {
    return new AiError("cli_login", "Claude Code isn't signed in", text);
  }
  if (lastRetryError === "model_not_found" || /model.{0,40}(not found|not available|isn't available|invalid|does not exist)|not_found_error/i.test(text)) {
    return new AiError("model_unavailable", "This model isn't available to the Claude Code sign-in", text);
  }
  if (result?.subtype === "error_max_turns") return new AiError("invalid_output", "Claude stopped before finishing (turn limit)", text);
  if (result?.subtype === "error_max_structured_output_retries") return new AiError("invalid_output", "The AI response did not match the expected format", text);
  return new AiError("api", text || "Claude Code failed", text);
}

/** One `claude -p` run. Resolves with the final `result` event; rejects with an AiError. */
export async function runClaudeCode(options: CliRunOptions): Promise<CliRunResult> {
  await acquire();
  // `held`: this run counts against the cap right now. `finished`: the run is over, so a yield
  // that ends later must not take a slot back (or must hand straight back the one it got).
  let held = true;
  let finished = false;
  const yieldSlot = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (!held || finished) return fn();
    held = false;
    release();
    try {
      return await fn();
    } finally {
      if (!finished) {
        await acquire();
        if (finished) release();
        else held = true;
      }
    }
  };
  let tmp: string | null = null;
  try {
    options.onSlot?.(yieldSlot);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-cc-"));
    const systemPrompt = path.join(tmp, "system.txt");
    fs.writeFileSync(systemPrompt, options.systemPrompt, { mode: 0o600 });
    let mcpConfig: string | null = null;
    if (options.mcpServers) {
      mcpConfig = path.join(tmp, "mcp.json");
      fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: options.mcpServers }), { mode: 0o600 });
    }
    const args = buildCliArgs(options, { systemPrompt, mcpConfig });
    return await new Promise<CliRunResult>((resolve, reject) => {
      let child: CliProcess;
      try {
        child = state.spawner(claudeBinary(), args, { cwd: workDir(), env: cliEnv() });
      } catch (error) {
        reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new AiError("cli_missing", "Claude Code CLI not found") : error);
        return;
      }
      const messages: CliEvent[] = [];
      let result: CliEvent | null = null;
      let sessionId: string | null = null;
      let stderr = "";
      let lastRetryError: string | null = null;
      let settled = false;
      const finish = (error: unknown | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else if (!result) reject(cliFailure(null, stderr, lastRetryError));
        else if (result.is_error === true || (result.subtype && result.subtype !== "success")) reject(cliFailure(result, stderr, lastRetryError));
        else resolve({ result, messages, sessionId });
      };
      const stop = () => {
        child.kill("SIGINT");
        setTimeout(() => child.kill("SIGTERM"), 3_000).unref?.();
      };
      const onAbort = () => {
        stop();
        finish(Object.assign(new Error("Cancelled"), { name: "AbortError" }));
      };
      const timer = setTimeout(() => {
        stop();
        finish(new AiError("api", "Claude Code took too long"));
      }, RUN_TIMEOUT_MS);
      timer.unref?.();
      if (options.signal?.aborted) return onAbort();
      options.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("error", (error) => finish((error as NodeJS.ErrnoException).code === "ENOENT" ? new AiError("cli_missing", "Claude Code CLI not found") : error));
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-8_000);
      });
      const lines = createInterface({ input: child.stdout! });
      lines.on("line", (line) => {
        if (!line.startsWith("{")) return;
        let event: CliEvent;
        try {
          event = JSON.parse(line) as CliEvent;
        } catch {
          return;
        }
        if (typeof event.session_id === "string") sessionId = event.session_id;
        if (event.type === "assistant" || event.type === "user") messages.push(event);
        else if (event.type === "result") result = event;
        else if (event.type === "rate_limit_event") recordRateLimit(event.rate_limit_info);
        else if (event.type === "system" && event.subtype === "api_retry" && typeof event.error === "string") lastRetryError = event.error;
        try {
          options.onEvent?.(event);
        } catch (error) {
          stop();
          finish(error);
        }
      });
      // Done once the process has exited and every line of its output has been read.
      let childClosed = false;
      let linesClosed = false;
      lines.on("close", () => {
        linesClosed = true;
        if (childClosed) finish(null);
      });
      child.on("close", () => {
        childClosed = true;
        if (linesClosed) finish(null);
      });

      child.stdin?.on("error", () => undefined);
      child.stdin?.end(`${JSON.stringify({ type: "user", message: { role: "user", content: options.input } })}\n`);
    });
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    finished = true;
    if (held) {
      held = false;
      release();
    }
  }
}
