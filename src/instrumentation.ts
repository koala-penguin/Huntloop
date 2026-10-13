export async function register() {
  // The database and background worker only exist in the Node.js server runtime, not during builds.
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { boot } = await import("./server/boot");
  await boot();
}
