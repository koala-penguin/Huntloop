import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NEGATIVE_STATUS_MAX_TTL_MS,
  NEGATIVE_STATUS_TTL_MS,
  cachedClaudeCodeStatus,
  defaultConnection,
  getClaudeCodeStatus,
  markSignedOut,
  setClaudeCodeChecker,
  setClaudeCodeStatus,
  subscriptionReady,
  type ClaudeCodeStatus,
} from "@/server/ai/claude-code/status";

const signedOut: ClaudeCodeStatus = { found: true, version: "2.1.296", loggedIn: false, authMethod: null, checkedAt: new Date(), error: null };
const signedIn: ClaudeCodeStatus = { ...signedOut, loggedIn: true, authMethod: "claude.ai" };
const missing: ClaudeCodeStatus = { ...signedOut, found: false, version: null };

let answer: ClaudeCodeStatus;
let calls: number;
const T0 = new Date("2026-10-20T00:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  calls = 0;
  answer = signedOut;
  setClaudeCodeStatus(null);
  setClaudeCodeChecker(async () => {
    calls++;
    return { ...answer, checkedAt: new Date() };
  });
});
afterEach(() => {
  setClaudeCodeChecker(null);
  setClaudeCodeStatus(null);
  vi.useRealTimers();
});

/** Time until the next check, measured by advancing the clock a second at a time. */
async function nextCheckAfter(): Promise<number> {
  const before = calls;
  const start = Date.now();
  for (let i = 0; i < 3600 && calls === before; i++) {
    vi.setSystemTime(Date.now() + 1000);
    await getClaudeCodeStatus();
  }
  return Date.now() - start;
}

describe("Claude Code status cache", () => {
  it("re-checks an expired negative answer, keeps a fresh one, and keeps a positive one", async () => {
    expect(await getClaudeCodeStatus()).toMatchObject({ loggedIn: false });
    expect(calls).toBe(1);
    vi.setSystemTime(T0 + NEGATIVE_STATUS_TTL_MS - 1000);
    await getClaudeCodeStatus();
    expect(calls).toBe(1);
    vi.setSystemTime(T0 + NEGATIVE_STATUS_TTL_MS + 1);
    await getClaudeCodeStatus();
    expect(calls).toBe(2);

    answer = signedIn;
    await getClaudeCodeStatus({ refresh: true });
    expect(calls).toBe(3);
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(await getClaudeCodeStatus()).toMatchObject({ loggedIn: true });
    expect(calls).toBe(3);
  });

  it("measures the wait from when the check finished", async () => {
    setClaudeCodeChecker(async () => {
      calls++;
      // A slow CLI: 35 s pass during the check.
      vi.setSystemTime(Date.now() + 35_000);
      return { ...signedOut, checkedAt: new Date() };
    });
    await getClaudeCodeStatus();
    vi.setSystemTime(T0 + 35_000 + NEGATIVE_STATUS_TTL_MS - 1000);
    await getClaudeCodeStatus();
    expect(calls).toBe(1);
  });

  it("doubles the wait on each negative answer, caps it, and resets it on refresh", async () => {
    await getClaudeCodeStatus();
    expect(await nextCheckAfter()).toBe(NEGATIVE_STATUS_TTL_MS);
    expect(await nextCheckAfter()).toBe(2 * NEGATIVE_STATUS_TTL_MS);
    expect(await nextCheckAfter()).toBe(4 * NEGATIVE_STATUS_TTL_MS);
    for (let i = 0; i < 4; i++) await nextCheckAfter();
    expect(await nextCheckAfter()).toBe(NEGATIVE_STATUS_MAX_TTL_MS);

    const before = calls;
    await getClaudeCodeStatus({ refresh: true });
    expect(calls).toBe(before + 1);
    expect(await nextCheckAfter()).toBe(NEGATIVE_STATUS_TTL_MS);
  });

  it("shares one check between concurrent callers", async () => {
    await Promise.all([getClaudeCodeStatus(), getClaudeCodeStatus(), getClaudeCodeStatus()]);
    expect(calls).toBe(1);
  });

  it("markSignedOut turns a positive status negative", async () => {
    answer = signedIn;
    await getClaudeCodeStatus();
    expect(subscriptionReady()).toBe(true);
    markSignedOut("Not logged in");
    expect(cachedClaudeCodeStatus()).toMatchObject({ found: true, loggedIn: false, error: "Not logged in" });
    expect(subscriptionReady()).toBe(false);
    // Re-checked after the backoff, not immediately.
    await getClaudeCodeStatus();
    expect(calls).toBe(1);
  });

  it("defaults to the subscription whenever the CLI is installed, signed in or not", () => {
    expect(defaultConnection()).toBe("api");
    setClaudeCodeStatus(missing);
    expect(defaultConnection()).toBe("api");
    setClaudeCodeStatus(signedOut);
    expect(defaultConnection()).toBe("subscription");
    setClaudeCodeStatus(signedIn);
    expect(defaultConnection()).toBe("subscription");
  });
});
