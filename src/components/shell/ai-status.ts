import type { Connection } from "@/shared/ai-settings";

export type ShellAiStatus = "demo-forced" | "demo-api" | "subscription-paused" | "ok";

/**
 * Which banner the app shell shows: demo mode (forced by HUNTLOOP_AI=fake, or the API connection
 * without a key) or "AI work is paused" (the subscription is active but Claude Code isn't ready).
 */
export function shellAiStatus(input: { mode: "api" | "claude_code" | "fake"; connection: Connection; demoForced: boolean; cliReady: boolean }): ShellAiStatus {
  if (input.demoForced) return "demo-forced";
  if (input.mode === "fake") return "demo-api";
  if (input.connection === "subscription" && input.mode === "claude_code" && !input.cliReady) return "subscription-paused";
  return "ok";
}
