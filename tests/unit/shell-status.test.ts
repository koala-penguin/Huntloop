import { describe, expect, it } from "vitest";
import { shellAiStatus } from "@/components/shell/ai-status";

describe("shellAiStatus", () => {
  it.each([
    [{ mode: "fake", connection: "api", demoForced: true, cliReady: true }, "demo-forced"],
    [{ mode: "fake", connection: "subscription", demoForced: true, cliReady: false }, "demo-forced"],
    [{ mode: "fake", connection: "api", demoForced: false, cliReady: true }, "demo-api"],
    [{ mode: "claude_code", connection: "subscription", demoForced: false, cliReady: false }, "subscription-paused"],
    [{ mode: "claude_code", connection: "subscription", demoForced: false, cliReady: true }, "ok"],
    [{ mode: "api", connection: "api", demoForced: false, cliReady: false }, "ok"],
  ] as const)("%o → %s", (input, expected) => {
    expect(shellAiStatus(input)).toBe(expected);
  });
});
