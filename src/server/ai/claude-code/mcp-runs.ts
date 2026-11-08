import { randomBytes } from "node:crypto";
import { readEnv } from "../../config/env";

/**
 * Huntloop's own tools (chat actions, the guarded browser) offered to a `claude -p` run over MCP.
 * Each run gets a random bearer token that only lives while the run does; the MCP route
 * (/api/claude-code/mcp) serves the tools of the run the token belongs to.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

export interface McpRun {
  tools: McpTool[];
  call(name: string, input: Record<string, unknown>): Promise<McpToolResult>;
}

/** Prefix Claude Code gives the tools of the "huntloop" MCP server. */
export const MCP_PREFIX = "mcp__huntloop__";

interface RunState {
  runs: Map<string, McpRun>;
}

const state: RunState = ((globalThis as unknown as { huntloopMcpRuns?: RunState }).huntloopMcpRuns ??= { runs: new Map() });

export function openMcpRun(run: McpRun): { token: string; close(): void } {
  const token = randomBytes(32).toString("hex");
  state.runs.set(token, run);
  return { token, close: () => state.runs.delete(token) };
}

export function getMcpRun(token: string | null | undefined): McpRun | undefined {
  return token ? state.runs.get(token) : undefined;
}

/** Where the CLI reaches Huntloop: it listens on 127.0.0.1 (npm run dev/start); Next sets PORT to the port in use. */
export function huntloopOrigin(): string {
  return readEnv().HUNTLOOP_ORIGIN?.replace(/\/+$/, "") ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

/** The `--mcp-config` servers entry for a run. */
export function mcpServersFor(token: string): Record<string, unknown> {
  return { huntloop: { type: "http", url: `${huntloopOrigin()}/api/claude-code/mcp`, headers: { Authorization: `Bearer ${token}` } } };
}
