import { z } from "zod";
import { checkWatch } from "../../watchlist/watchlist";
import { registerTaskHandler, type TaskContext } from "../runner";

export const WATCH_CHECK_TASK = "watch-check";

const payloadSchema = z.object({ watchId: z.number().int() });

/** Checks one watched job board for new and closed roles (public API, no AI). */
export async function runWatchCheck(ctx: TaskContext) {
  const { watchId } = payloadSchema.parse(ctx.payload);
  ctx.progress({ stage: "checking" });
  return checkWatch(ctx.db, ctx.userId, watchId);
}

registerTaskHandler(WATCH_CHECK_TASK, { run: runWatchCheck, maxAttempts: 1 });
