import type Anthropic from "@anthropic-ai/sdk";
import { MODELS, type Effort, type ModelId } from "@/shared/models";

type Beta = Anthropic.Beta.AnthropicBeta;
type ThinkingConfig = Anthropic.Beta.Messages.BetaThinkingConfigAdaptive;
type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type UserLocation = Anthropic.Beta.Messages.BetaUserLocation;

export const BETA_FALLBACK = "server-side-fallback-2026-07-01";
export const BETA_DISPLAY_UPDATES = "thinking-display-updates-2026-08-18";
export const BETA_BLOCK_BINDING = "thinking-binding-controls-2026-08-01";
export const BETA_CONTEXT_MANAGEMENT = "context-management-2025-06-27";

export interface RequestOptions {
  maxTokens?: number;
  /** Show the model's short progress notes between tool calls (agentic and chat turns). */
  progressUpdates?: boolean;
  /** Preserved-thinking guard for multi-turn conversations. */
  prefixMismatch?: "error" | "drop_block";
  /** Betas the request needs (e.g. context management); always sent. */
  extraBetas?: Beta[];
  /**
   * Leave out optional beta features (fallbacks, progress notes, block binding).
   * Set after a request with them was rejected, so a feature mismatch never blocks the user.
   */
  withoutOptionalFeatures?: boolean;
}

export interface BaseParams {
  model: ModelId;
  max_tokens: number;
  thinking: ThinkingConfig;
  output_config: { effort: Effort };
  betas: Beta[];
  fallbacks?: "default";
}

/**
 * Request parameters shared by every Claude call, adapted to the chosen model's capabilities.
 * Thinking is always adaptive (current models reject disabled thinking and budgets); depth is
 * controlled with `effort`, which is always sent explicitly. No sampling parameters are sent.
 */
export function buildBaseParams(model: ModelId, effort: Effort, options: RequestOptions = {}): BaseParams {
  const info = MODELS[model];
  const optional = !options.withoutOptionalFeatures;
  const betas: Beta[] = [...(options.extraBetas ?? [])];
  const thinking: ThinkingConfig = { type: "adaptive" };

  if (optional && options.progressUpdates && info.displayUpdates) {
    thinking.display = "updates";
    betas.push(BETA_DISPLAY_UPDATES);
  }
  if (optional && options.prefixMismatch) {
    thinking.block_binding = { prefix_mismatch_behavior: options.prefixMismatch };
    betas.push(BETA_BLOCK_BINDING);
  }

  const params: BaseParams = {
    model,
    max_tokens: options.maxTokens ?? 32_000,
    thinking,
    output_config: { effort },
    betas,
  };
  if (optional && info.fallbackDefault) {
    params.fallbacks = "default";
    betas.push(BETA_FALLBACK);
  }
  return params;
}

export interface WebToolOptions {
  searchMaxUses?: number;
  fetchMaxUses?: number;
  userLocation?: Omit<UserLocation, "type">;
  allowedDomains?: string[];
  blockedDomains?: string[];
  /** Leave web_fetch out (e.g. when fetching restricted sites must not happen). */
  withoutFetch?: boolean;
}

/** Server-side web search + fetch tools in the version the model supports. */
export function webTools(model: ModelId, options: WebToolOptions = {}): ToolUnion[] {
  const info = MODELS[model];
  const domainFilter = options.allowedDomains?.length
    ? { allowed_domains: options.allowedDomains }
    : options.blockedDomains?.length
      ? { blocked_domains: options.blockedDomains }
      : {};
  const search = {
    type: info.webSearchTool,
    name: "web_search",
    max_uses: options.searchMaxUses ?? 5,
    ...domainFilter,
    ...(options.userLocation ? { user_location: { type: "approximate", ...options.userLocation } } : {}),
  } as ToolUnion;
  if (options.withoutFetch) return [search];
  const fetch = {
    type: info.webFetchTool,
    name: "web_fetch",
    max_uses: options.fetchMaxUses ?? 5,
    max_content_tokens: 20_000,
    ...(options.blockedDomains?.length ? { blocked_domains: options.blockedDomains } : {}),
  } as ToolUnion;
  return [search, fetch];
}
