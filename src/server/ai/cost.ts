import { pricingFor, WEB_SEARCH_PRICE_USD, type ModelPricing } from "@/shared/models";

/** The subset of the API's usage object that cost depends on (works for beta and non-beta usage). */
export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
  iterations?: Array<{
    type: string;
    model?: string | null;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  }> | null;
}

export interface UsageCost {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  costUsd: number;
}

interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
}

function priceTokens(p: ModelPricing, t: TokenCounts): number {
  const promptTokens = t.input + t.cacheRead + t.cacheWrite;
  const long = p.longContext && promptTokens > p.longContext.thresholdTokens ? p.longContext : undefined;
  const inputRate = long?.input ?? p.input;
  const outputRate = long?.output ?? p.output;
  const write5m = t.cacheWrite - t.cacheWrite1h;
  return (
    (t.input * inputRate +
      t.output * outputRate +
      t.cacheRead * p.cacheRead +
      write5m * p.cacheWrite5m +
      t.cacheWrite1h * p.cacheWrite1h) /
    1_000_000
  );
}

/**
 * Cost of one API response. When `usage.iterations` is present (server-side tool loops, refusal
 * fallbacks, compaction) each iteration is priced with the model that served it; the top-level
 * numbers can miss fallback attempts.
 */
export function computeCost(requestModel: string, usage: UsageLike): UsageCost {
  const requestPricing = pricingFor(requestModel);
  const webSearches = usage.server_tool_use?.web_search_requests ?? 0;
  const iterations = usage.iterations?.length ? usage.iterations : null;

  const parts: Array<{ model: string | null | undefined; t: TokenCounts }> = iterations
    ? iterations.map((it) => ({
        model: it.model ?? requestModel,
        t: {
          input: it.input_tokens,
          output: it.output_tokens,
          cacheRead: it.cache_read_input_tokens ?? 0,
          cacheWrite: it.cache_creation_input_tokens ?? 0,
          cacheWrite1h: it.cache_creation?.ephemeral_1h_input_tokens ?? 0,
        },
      }))
    : [
        {
          model: requestModel,
          t: {
            input: usage.input_tokens,
            output: usage.output_tokens,
            cacheRead: usage.cache_read_input_tokens ?? 0,
            cacheWrite: usage.cache_creation_input_tokens ?? 0,
            cacheWrite1h: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          },
        },
      ];

  let costUsd = webSearches * WEB_SEARCH_PRICE_USD;
  const totals: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
  for (const part of parts) {
    const pricing = pricingFor(part.model) ?? requestPricing;
    if (pricing) costUsd += priceTokens(pricing, part.t);
    totals.input += part.t.input;
    totals.output += part.t.output;
    totals.cacheRead += part.t.cacheRead;
    totals.cacheWrite += part.t.cacheWrite;
  }

  return {
    inputTokens: totals.input,
    outputTokens: totals.output,
    cacheReadTokens: totals.cacheRead,
    cacheWriteTokens: totals.cacheWrite,
    webSearches,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
  };
}
