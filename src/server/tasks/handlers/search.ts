import { z } from "zod";
import { runSearch } from "../../search/run";
import { SEARCH_TASK } from "../../search/tasks";
import { registerTaskHandler, type TaskContext } from "../runner";

const payloadSchema = z.object({ searchId: z.number().int(), scheduled: z.boolean().optional() });

export async function runSearchTask(ctx: TaskContext) {
  const { searchId, scheduled } = payloadSchema.parse(ctx.payload);
  return runSearch({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, searchId, {
    taskId: ctx.task.id,
    onProgress: ctx.progress,
    // Nobody is watching a scheduled run: no browser sources, so nothing can wait for the user.
    waitForUser: scheduled ? undefined : ctx.waitForUser,
    apiOnly: scheduled,
  });
}

// A second attempt after a crash is cheap: finished jobs are recognised and cached analyses reused.
registerTaskHandler(SEARCH_TASK, { run: runSearchTask, maxAttempts: 2 });
