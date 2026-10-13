import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getMcpRun } from "@/server/ai/claude-code/mcp-runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * MCP endpoint for the user's Claude Code CLI while it answers for Huntloop (subscription
 * connection): lists and runs the tools of one run, identified by its short-lived bearer token.
 */
async function handle(request: Request): Promise<Response> {
  const token = /^Bearer\s+([a-f0-9]{64})$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const run = getMcpRun(token);
  if (!run) return new Response("Unauthorized", { status: 401 });

  const server = new Server({ name: "huntloop", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: run.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: "object" as const, ...t.inputSchema } })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const out = await run.call(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text" as const, text: out.text }], isError: out.isError };
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
