/**
 * Demo / test transport: a `fetch` replacement that answers Messages API calls locally, so the
 * real Anthropic SDK request and stream-parsing code runs without an API key. Each AI task
 * registers a generator that builds a plausible response from the request body.
 */
import { countUnionParams, UNION_PARAM_LIMIT } from "../schema-limits";

export interface FakeRequest {
  task: string;
  // Raw request body as sent by the SDK.
  body: {
    model: string;
    system?: unknown;
    messages: Array<{ role: string; content: unknown }>;
    tools?: Array<{ name?: string; type?: string }>;
    output_config?: { format?: unknown };
    stream?: boolean;
  };
}

export interface FakeReply {
  content: Array<Record<string, unknown>>;
  stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn";
  webSearches?: number;
}

export type FakeGenerator = (req: FakeRequest) => FakeReply | Promise<FakeReply>;

const generators = new Map<string, FakeGenerator>();

export function registerFakeGenerator(task: string, generator: FakeGenerator): void {
  generators.set(task, generator);
}

export function getFakeGenerator(task: string): FakeGenerator | undefined {
  return generators.get(task);
}

/** Text of the most recent user message (string content or text blocks). */
export function lastUserText(body: FakeRequest["body"]): string {
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      const texts = m.content
        .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
        .map((b) => b.text);
      if (texts.length) return texts.join("\n");
    }
  }
  return "";
}

/** All text in the request (system + messages), for generators that need to echo input. */
export function allRequestText(body: FakeRequest["body"]): string {
  const parts: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") {
      const block = value as Record<string, unknown>;
      if (typeof block.text === "string") parts.push(block.text);
      if (block.source && typeof block.source === "object") {
        const source = block.source as Record<string, unknown>;
        if (source.type === "text" && typeof source.data === "string") parts.push(source.data);
      }
      if (Array.isArray(block.content)) block.content.forEach(collect);
    }
  };
  collect(body.system);
  body.messages.forEach((m) => collect(m.content));
  return parts.join("\n");
}

export function containsHangul(text: string): boolean {
  return /[ㄱ-힝]/.test(text);
}

const defaultChat: FakeGenerator = (req) => {
  const korean = containsHangul(lastUserText(req.body));
  const text = korean
    ? "데모 모드입니다. `.env.local`에 `ANTHROPIC_API_KEY`를 추가하면 Claude가 실제로 답변합니다."
    : "This is demo mode. Add `ANTHROPIC_API_KEY` to `.env.local` and Claude will answer for real.";
  return { content: [{ type: "text", text }] };
};

let counter = 0;
const nextId = (prefix: string) => `${prefix}_fake_${Date.now().toString(36)}_${(counter++).toString(36)}`;

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value ?? "").length / 4));
}

function buildMessage(model: string, reply: FakeReply, inputTokens: number) {
  return {
    id: nextId("msg"),
    type: "message",
    role: "assistant",
    model,
    content: reply.content,
    stop_reason: reply.stop_reason ?? (reply.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: estimateTokens(reply.content),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: reply.webSearches ? { web_search_requests: reply.webSearches, web_fetch_requests: 0 } : null,
    },
  };
}

function chunk(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

function sseEvents(message: ReturnType<typeof buildMessage>): Array<{ event: string; data: unknown }> {
  const events: Array<{ event: string; data: unknown }> = [];
  events.push({
    event: "message_start",
    data: { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } } },
  });
  message.content.forEach((block, index) => {
    const type = block.type as string;
    if (type === "text") {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
      for (const piece of chunk(String(block.text ?? ""))) {
        events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "text_delta", text: piece } } });
      }
    } else if (type === "thinking") {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } } });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: String(block.thinking ?? "") } } });
      events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "fake-signature" } } });
    } else if (type === "tool_use") {
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: { ...block, input: {} } } });
      for (const piece of chunk(JSON.stringify(block.input ?? {}), 40)) {
        events.push({ event: "content_block_delta", data: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: piece } } });
      }
    } else {
      // Server tool blocks and results arrive complete in content_block_start.
      events.push({ event: "content_block_start", data: { type: "content_block_start", index, content_block: block } });
    }
    events.push({ event: "content_block_stop", data: { type: "content_block_stop", index } });
  });
  events.push({
    event: "message_delta",
    data: { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: null }, usage: message.usage },
  });
  events.push({ event: "message_stop", data: { type: "message_stop" } });
  return events;
}

function sseResponse(events: Array<{ event: string; data: unknown }>, delayMs: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const e of events) {
        controller.enqueue(encoder.encode(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`));
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** Union-typed parameters across a request's strict schemas (the output format and every strict tool). */
export function strictUnionParams(body: FakeRequest["body"]): number {
  const format = body.output_config?.format as { schema?: unknown } | undefined;
  const tools = (body.tools ?? []) as Array<{ strict?: boolean; input_schema?: unknown }>;
  return countUnionParams(format?.schema) + tools.filter((t) => t.strict).reduce((n, t) => n + countUnionParams(t.input_schema), 0);
}

/**
 * Test-only rules `"<marker>:<task>,<task>[=<value>];…"`: the value of the first rule listing this
 * task whose marker appears in the request text ("" without a value), or null.
 */
function fakeRule(task: string, body: FakeRequest["body"], spec: string | undefined): string | null {
  if (!spec) return null;
  let text: string | undefined;
  for (const rule of spec.split(";")) {
    const match = /^([^:]+):([^=]+)(?:=(.*))?$/.exec(rule.trim());
    if (!match) continue;
    const [, marker, tasks, value] = match;
    if (!tasks.split(",").map((t) => t.trim()).includes(task)) continue;
    text ??= allRequestText(body);
    if (text.includes(marker)) return value ?? "";
  }
  return null;
}

/**
 * Test-only slow-down: `HUNTLOOP_FAKE_DELAY="<marker>:<task>,<task>=<ms>;…"` holds a demo reply for
 * <ms> when the request is for one of those tasks and its text contains <marker>, so e2e tests can
 * act while a background task is still running. Unset (the default): no delay.
 */
export function fakeDelayMs(task: string, body: FakeRequest["body"], spec = process.env.HUNTLOOP_FAKE_DELAY): number {
  const ms = Number(fakeRule(task, body, spec));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Test-only failure: `HUNTLOOP_FAKE_FAIL="<marker>:<task>,<task>;…"` answers those requests with an
 * API error (after any delay), so e2e tests can see a task fail. Unset (the default): never.
 */
export function fakeFails(task: string, body: FakeRequest["body"], spec = process.env.HUNTLOOP_FAKE_FAIL): boolean {
  return fakeRule(task, body, spec) !== null;
}

export interface FakeFetchOptions {
  /** Delay between streamed events, so demo mode visibly streams. */
  streamDelayMs?: number;
  /** Model ids to report from GET /v1/models. */
  models?: string[];
}

export function createFakeFetch(options: FakeFetchOptions = {}): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && url.pathname.startsWith("/v1/models")) {
      const data = (options.models ?? []).map((id) => ({ id, type: "model", display_name: id, created_at: "2026-01-01T00:00:00Z" }));
      return json({ data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
    }

    if (method === "POST" && url.pathname === "/v1/messages") {
      const headers = new Headers(init?.headers);
      const task = headers.get("x-huntloop-task") ?? "chat";
      const body = JSON.parse(String(init?.body ?? "{}")) as FakeRequest["body"];
      // Like the API: strict schemas (structured output, strict tools) over the union limit are rejected.
      const unions = strictUnionParams(body);
      if (unions > UNION_PARAM_LIMIT) {
        const message = `Schemas contains too many parameters with union types (${unions} parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: ${UNION_PARAM_LIMIT} parameters with unions).`;
        return json({ type: "error", error: { type: "invalid_request_error", message } }, 400);
      }
      const generator = generators.get(task) ?? (body.output_config?.format ? undefined : defaultChat);
      if (!generator) {
        return json({ type: "error", error: { type: "invalid_request_error", message: `No demo response for task "${task}"` } }, 400);
      }
      const delay = fakeDelayMs(task, body);
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (fakeFails(task, body)) {
        return json({ type: "error", error: { type: "invalid_request_error", message: "Simulated failure (HUNTLOOP_FAKE_FAIL)" } }, 400);
      }
      const reply = await generator({ task, body });
      const message = buildMessage(body.model, reply, estimateTokens(body.messages) + estimateTokens(body.system));
      return body.stream ? sseResponse(sseEvents(message), options.streamDelayMs ?? 0) : json(message);
    }

    return json({ type: "error", error: { type: "not_found_error", message: `${method} ${url.pathname}` } }, 404);
  };
}
