/**
 * Claude model registry: prices and the API capabilities that change how requests are built.
 * Prices are USD per million tokens (Anthropic first-party API, as of Oct 2026).
 */

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

export const MODEL_IDS = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
  "claude-fable-5-1",
] as const;
export type ModelId = (typeof MODEL_IDS)[number];

export const DEFAULT_MODEL: ModelId = "claude-opus-5-5";

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** Some models charge more once a prompt passes a size threshold. */
  longContext?: { thresholdTokens: number; input: number; output: number };
}

export interface ModelInfo {
  id: ModelId;
  label: string;
  pricing: ModelPricing;
  webSearchTool: "web_search_20260209" | "web_search_20250305";
  webFetchTool: "web_fetch_20260209" | "web_fetch_20250910";
  /** Server-side refusal fallback (`fallbacks: "default"`). */
  fallbackDefault: boolean;
  /** `thinking.display: "updates"` progress notes between tool calls. */
  displayUpdates: boolean;
  defaultEffort: Effort;
}

export const MODELS: Record<ModelId, ModelInfo> = {
  "claude-opus-5-5": {
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
    webSearchTool: "web_search_20260209",
    webFetchTool: "web_fetch_20260209",
    fallbackDefault: true,
    displayUpdates: true,
    defaultEffort: "medium",
  },
  "claude-sonnet-5-5": {
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
    webSearchTool: "web_search_20260209",
    webFetchTool: "web_fetch_20260209",
    fallbackDefault: true,
    displayUpdates: true,
    defaultEffort: "high",
  },
  "claude-haiku-5-5": {
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    pricing: {
      input: 0.1,
      output: 0.5,
      cacheRead: 0.01,
      cacheWrite5m: 0.125,
      cacheWrite1h: 0.2,
      longContext: { thresholdTokens: 100_000, input: 0.5, output: 2.5 },
    },
    webSearchTool: "web_search_20250305",
    webFetchTool: "web_fetch_20250910",
    fallbackDefault: false,
    displayUpdates: false,
    defaultEffort: "medium",
  },
  "claude-fable-5-1": {
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    pricing: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
    webSearchTool: "web_search_20260209",
    webFetchTool: "web_fetch_20260209",
    fallbackDefault: true,
    displayUpdates: true,
    defaultEffort: "high",
  },
};

/** Prices for models that can serve a request through server-side fallback. */
export const FALLBACK_PRICING: Record<string, ModelPricing> = {
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
};

/** USD per web search request. Web fetch has no per-request fee. */
export const WEB_SEARCH_PRICE_USD = 0.01;

export function isModelId(value: unknown): value is ModelId {
  return typeof value === "string" && (MODEL_IDS as readonly string[]).includes(value);
}

export function pricingFor(model: string | null | undefined): ModelPricing | undefined {
  if (!model) return undefined;
  if (isModelId(model)) return MODELS[model].pricing;
  return FALLBACK_PRICING[model];
}
