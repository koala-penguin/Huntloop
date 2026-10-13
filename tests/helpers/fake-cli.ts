import { EventEmitter } from "node:events";
import fs from "node:fs";
import { PassThrough } from "node:stream";
import type { CliEvent, CliProcess, CliSpawner } from "@/server/ai/claude-code/cli";
import { POST as mcpPost } from "@/app/api/claude-code/mcp/route";

export interface FakeCliCall {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** The stream-json user message written to stdin. */
  input: { type: string; message: { role: string; content: Array<Record<string, unknown>> } };
  /** Value following a flag, e.g. arg("--model"). */
  arg(flag: string): string | undefined;
  /** Print an event right away (before the scripted rest), e.g. an assistant tool_use ahead of an MCP call. */
  write(event: CliEvent): void;
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
        write: (event) => {
          stdout.write(`${JSON.stringify(event)}\n`);
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

export interface McpServerEntry {
  url: string;
  headers: { Authorization: string };
}

/** The MCP server the CLI was given (read while the run is going; the file is removed afterwards). */
export function mcpServer(call: FakeCliCall): McpServerEntry {
  return (JSON.parse(fs.readFileSync(call.arg("--mcp-config")!, "utf8")) as { mcpServers: { huntloop: McpServerEntry } }).mcpServers.huntloop;
}

/** What the CLI would do: talk JSON-RPC to Huntloop's MCP route with the run's bearer token. */
export async function mcp(server: McpServerEntry, method: string, params: Record<string, unknown>, authorization = server.headers.Authorization) {
  const response = await mcpPost(
    new Request(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return { status: response.status, body: response.status === 200 ? ((await response.json()) as { result: Record<string, unknown> }) : null };
}
