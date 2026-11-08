import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Opt-in checks against the real Claude Code CLI / API (`npm run test:live`). They use your plan's limits or credits. */
export default defineConfig({
  test: {
    include: ["tests/live/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 300_000,
    fileParallelism: false,
    env: { NODE_ENV: "test" },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/stubs/server-only.ts", import.meta.url)),
    },
  },
});
