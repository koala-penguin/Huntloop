import { z } from "zod";
import { runSearch } from "../../search/run";
import { SEARCH_TASK } from "../../search/tasks";
import { registerTaskHandler, type TaskContext } from "../runner";

const payloadSchema = z.object({ searchId: z.number().int() });

export async function runSearchTask(ctx: TaskContext) {
  const { searchId } = payloadSchema.parse(ctx.payload);
  return runSearch({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, searchId, { taskId: ctx.task.id, onProgress: ctx.progress, waitForUser: ctx.waitForUser });
}

// A second attempt after a crash is cheap: finished jobs are recognised and cached analyses reused.
registerTaskHandler(SEARCH_TASK, { run: runSearchTask, maxAttempts: 2 });
