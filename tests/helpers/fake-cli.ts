import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { CliEvent, CliProcess, CliSpawner } from "@/server/ai/claude-code/cli";

export interface FakeCliCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The stream-json user message written to stdin. */
  input: { type: string; message: { role: string; content: Array<Record<string, unknown>> } };
  /** Value following a flag, e.g. arg("--model"). */
  arg(flag: string): string | undefined;
}

export type FakeCliScript = (call: FakeCliCall) => CliEvent[] | { events: CliEvent[]; stderr?: string; exitCode?: number } | Promise<CliEvent[]>;

/** A stand-in for `claude -p`: reads the stdin message, then prints the scripted stream-json events. */
export function fakeCli(script: FakeCliScript): { spawner: CliSpawner; calls: FakeCliCall[] } {
  const calls: FakeCliCall[] = [];
  const spawner: CliSpawner = (command, args, options) => {
    const emitter = new EventEmitter();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let input = "";
    stdin.on("data", (chunk: Buffer) => (input += chunk.toString()));
    stdin.on("finish", async () => {
      const call: FakeCliCall = {
        command,
        args,
        env: options.env,
        cwd: options.cwd,
        input: JSON.parse(input.trim().split("\n")[0]),
        arg: (flag) => {
          const i = args.indexOf(flag);
          return i >= 0 ? args[i + 1] : undefined;
        },
      };
      calls.push(call);
      const out = await script(call);
      const events = Array.isArray(out) ? out : out.events;
      for (const event of events) stdout.write(`${JSON.stringify(event)}\n`);
      if (!Array.isArray(out) && out.stderr) stderr.write(out.stderr);
      stdout.end();
      stderr.end();
      setImmediate(() => emitter.emit("close", Array.isArray(out) ? 0 : (out.exitCode ?? 0)));
    });
    const proc: CliProcess = {
      stdin,
      stdout,
      stderr,
      kill: () => true,
      on: (event: string, listener: (...a: never[]) => void) => emitter.on(event, listener as (...a: unknown[]) => void),
    };
    return proc;
  };
  return { spawner, calls };
}

export const cliResult = (fields: Partial<CliEvent> = {}): CliEvent => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "sess-1",
  result: "",
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  total_cost_usd: 0.01,
  ...fields,
});

export const cliAssistant = (content: Array<Record<string, unknown>>, model = "claude-opus-5-5"): CliEvent => ({
  type: "assistant",
  session_id: "sess-1",
  parent_tool_use_id: null,
  message: { id: `msg_${Math.random().toString(36).slice(2)}`, role: "assistant", model, content, stop_reason: null },
});

export const cliToolResult = (toolUseId: string, content: string, structured: unknown = null, isError = false): CliEvent => ({
  type: "user",
  session_id: "sess-1",
  parent_tool_use_id: null,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, ...(isError ? { is_error: true } : {}) }] },
  tool_use_result: structured,
});
