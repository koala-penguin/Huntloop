import { describe, expect, it } from "vitest";
import { BETA_BLOCK_BINDING, BETA_DISPLAY_UPDATES, BETA_FALLBACK, buildBaseParams, webTools } from "@/server/ai/request";

describe("buildBaseParams", () => {
  it("uses adaptive thinking, explicit effort and server-side fallbacks on Opus 5.5", () => {
    const p = buildBaseParams("claude-opus-5-5", "medium");
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.output_config).toEqual({ effort: "medium" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual([BETA_FALLBACK]);
    expect(p).not.toHaveProperty("temperature");
  });

  it("never sends fallbacks or progress notes to Haiku 5.5", () => {
    const p = buildBaseParams("claude-haiku-5-5", "low", { progressUpdates: true });
    expect(p.fallbacks).toBeUndefined();
    expect(p.thinking.display).toBeUndefined();
    expect(p.betas).toEqual([]);
  });

  it("adds progress notes and block binding only when asked", () => {
    const p = buildBaseParams("claude-opus-5-5", "high", { progressUpdates: true, prefixMismatch: "drop_block" });
    expect(p.thinking).toEqual({ type: "adaptive", display: "updates", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(p.betas).toEqual(expect.arrayContaining([BETA_FALLBACK, BETA_DISPLAY_UPDATES, BETA_BLOCK_BINDING]));
  });

  it("drops every optional beta feature when degraded", () => {
    const p = buildBaseParams("claude-opus-5-5", "high", { progressUpdates: true, prefixMismatch: "error", withoutOptionalFeatures: true });
    expect(p.betas).toEqual([]);
    expect(p.fallbacks).toBeUndefined();
    expect(p.thinking).toEqual({ type: "adaptive" });
  });
});

describe("webTools", () => {
  it("uses the dynamic-filtering versions on Opus and the basic versions on Haiku", () => {
    expect(webTools("claude-opus-5-5").map((t) => t.type)).toEqual(["web_search_20260209", "web_fetch_20260209"]);
    expect(webTools("claude-haiku-5-5").map((t) => t.type)).toEqual(["web_search_20250305", "web_fetch_20250910"]);
  });

  it("passes location and domain filters, and can leave out fetch", () => {
    const [search, ...rest] = webTools("claude-opus-5-5", {
      userLocation: { country: "AU", city: "Sydney" },
      blockedDomains: ["linkedin.com"],
      withoutFetch: true,
    });
    expect(rest).toHaveLength(0);
    expect(search).toMatchObject({
      user_location: { type: "approximate", country: "AU", city: "Sydney" },
      blocked_domains: ["linkedin.com"],
    });
  });
});
