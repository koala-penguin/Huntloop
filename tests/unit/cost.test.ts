import { describe, expect, it } from "vitest";
import { computeCost } from "@/server/ai/cost";

describe("computeCost", () => {
  it("prices input, output and cache tokens with the model's rates", () => {
    const cost = computeCost("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    });
    // $4 input + $2 output + $0.20 cache read
    expect(cost.costUsd).toBeCloseTo(6.2, 6);
    expect(cost.inputTokens).toBe(1_000_000);
    expect(cost.cacheReadTokens).toBe(1_000_000);
  });

  it("adds $0.01 per web search", () => {
    const cost = computeCost("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      server_tool_use: { web_search_requests: 7, web_fetch_requests: 3 },
    });
    expect(cost.costUsd).toBeCloseTo(0.07, 6);
    expect(cost.webSearches).toBe(7);
  });

  it("prices each iteration with the model that served it (fallbacks)", () => {
    const cost = computeCost("claude-opus-5-5", {
      input_tokens: 999, // top-level numbers are ignored when iterations exist
      output_tokens: 999,
      iterations: [
        { type: "message", model: "claude-opus-5-5", input_tokens: 1_000_000, output_tokens: 0 },
        { type: "fallback_message", model: "claude-opus-4-8", input_tokens: 1_000_000, output_tokens: 0 },
      ],
    });
    expect(cost.costUsd).toBeCloseTo(4 + 5, 6);
    expect(cost.inputTokens).toBe(2_000_000);
  });

  it("applies Haiku 5.5 long-context pricing above 100K prompt tokens", () => {
    const short = computeCost("claude-haiku-5-5", { input_tokens: 100_000, output_tokens: 0 });
    const long = computeCost("claude-haiku-5-5", { input_tokens: 200_000, output_tokens: 0 });
    expect(short.costUsd).toBeCloseTo(0.01, 6);
    expect(long.costUsd).toBeCloseTo(0.1, 6);
  });

  it("separates 1-hour cache writes from 5-minute ones", () => {
    const cost = computeCost("claude-opus-5-5", {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 2_000_000,
      cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
    });
    expect(cost.costUsd).toBeCloseTo(5 + 8, 6);
  });
});
