import "server-only";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { AGENT_TOOLS } from "./guard";

const MAX_RESULT_CHARS = 30_000;

/**
 * Chrome DevTools MCP, attached to Huntloop's own browser window through its localhost DevTools
 * port. Script execution, performance, network, emulation and memory tools are switched off, and
 * usage statistics are disabled. Only the allowlisted tools are offered to Claude.
 */
export class McpBrowserBridge {
  private constructor(
    private readonly client: Client,
    private readonly toolDefs: Anthropic.Beta.Messages.BetaTool[],
  ) {}

  static async start(devtoolsUrl: string): Promise<McpBrowserBridge> {
    const bin = path.join(/*turbopackIgnore: true*/ process.cwd(), "node_modules", "chrome-devtools-mcp", "build", "src", "bin", "chrome-devtools-mcp.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        bin,
        "--browserUrl",
        devtoolsUrl,
        "--usageStatistics=false",
        "--performanceCrux=false",
        "--javascriptEvaluation=false",
        "--categoryPerformance=false",
        "--categoryNetwork=false",
        "--categoryEmulation=false",
        "--categoryMemory=false",
      ],
      // Only the basics (PATH, HOME, …): the server never gets Huntloop's API keys.
      env: { ...getDefaultEnvironment(), CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1" },
      stderr: "pipe",
    });
    // Drain stderr (an unread pipe would eventually block the server); keep the tail for errors.
    let stderrTail = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2_000);
    });
    const client = new Client({ name: "huntloop", version: "0.1.0" });
    try {
      await client.connect(transport);
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw new Error(`Chrome DevTools MCP didn't start: ${error instanceof Error ? error.message : String(error)}${stderrTail ? `\n${stderrTail}` : ""}`);
    }
    const { tools } = await client.listTools();
    const allowed = new Set<string>(AGENT_TOOLS);
    const defs = tools
      .filter((t) => allowed.has(t.name))
      .map((t) => {
        const schema = { ...(t.inputSchema as Record<string, unknown>) };
        delete schema.$schema;
        const props = { ...((schema.properties ?? {}) as Record<string, unknown>) };
        // Options the guard strips anyway; don't advertise them.
        for (const key of ["filePath", "isolatedContext", "background", "verbose", "dblClick"]) delete props[key];
        return { name: t.name, description: t.description ?? t.name, input_schema: { ...schema, properties: props } } as Anthropic.Beta.Messages.BetaTool;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return new McpBrowserBridge(client, defs);
  }

  tools(): Anthropic.Beta.Messages.BetaTool[] {
    return this.toolDefs;
  }

  /** Runs one (already guarded) tool call; returns its text output (images are dropped). */
  async call(name: string, input: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    try {
      const result = await this.client.callTool({ name, arguments: input });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      let text = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated)`;
      return { text: text || "(no output)", isError: !!result.isError };
    } catch (error) {
      return { text: `Tool failed: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
