import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataPath, readEnv } from "@/server/config/env";

const env = (vars: Record<string, string>) => vars as unknown as NodeJS.ProcessEnv;

const original = process.env.HUNTLOOP_DATA_DIR;
let tmp = "";
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-data-paths-"));
  process.env.HUNTLOOP_DATA_DIR = tmp;
});
afterAll(() => {
  process.env.HUNTLOOP_DATA_DIR = original;
});

describe("dataPath", () => {
  it("joins segments under HUNTLOOP_DATA_DIR", () => {
    expect(dataPath("a", "b")).toBe(path.join(path.resolve(tmp), "a", "b"));
    expect(dataPath()).toBe(path.resolve(tmp));
  });
});

describe("HUNTLOOP_CLAUDE_PATH", () => {
  it("defaults to claude on PATH when unset or empty", () => {
    expect(readEnv(env({})).HUNTLOOP_CLAUDE_PATH).toBe("claude");
    expect(readEnv(env({ HUNTLOOP_CLAUDE_PATH: "" })).HUNTLOOP_CLAUDE_PATH).toBe("claude");
  });

  it("keeps a configured path", () => {
    expect(readEnv(env({ HUNTLOOP_CLAUDE_PATH: "/x/claude" })).HUNTLOOP_CLAUDE_PATH).toBe("/x/claude");
  });
});
