import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { tasks } from "@/server/db/schema";
import { cancelTask, enqueueTask, getTask, registerTaskHandler, TaskRunner } from "@/server/tasks/runner";
import { testDb } from "../helpers/db";

describe("TaskRunner", () => {
  it("runs a queued task, records progress and the result", async () => {
    const { db, userId } = testDb();
    registerTaskHandler("test-ok", {
      run: async (ctx) => {
        ctx.progress({ step: 1 });
        return { echoed: ctx.payload };
      },
    });
    const task = enqueueTask(db, userId, "test-ok", { hello: "world" });
    const runner = new TaskRunner(db);
    await Promise.all(await runner.tick());
    const done = getTask(db, task.id)!;
    expect(done.status).toBe("succeeded");
    expect(done.result).toEqual({ echoed: { hello: "world" } });
    expect(done.progress).toEqual({ step: 1 });
    expect(done.attempts).toBe(1);
  });

  it("marks failures with the error message", async () => {
    const { db, userId } = testDb();
    registerTaskHandler("test-fail", { run: async () => Promise.reject(new Error("boom")) });
    const task = enqueueTask(db, userId, "test-fail", null);
    await Promise.all(await new TaskRunner(db).tick());
    expect(getTask(db, task.id)).toMatchObject({ status: "failed", error: "boom" });
  });

  it("fails tasks with no registered handler", async () => {
    const { db, userId } = testDb();
    const task = enqueueTask(db, userId, "test-unknown", null);
    await new TaskRunner(db).tick();
    expect(getTask(db, task.id)?.status).toBe("failed");
  });

  it("never runs two tasks of the same exclusive group at once", async () => {
    const { db, userId } = testDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    registerTaskHandler("test-browser", { exclusiveGroup: "browser", run: () => gate });
    const a = enqueueTask(db, userId, "test-browser", null);
    const b = enqueueTask(db, userId, "test-browser", null);
    const runner = new TaskRunner(db, { concurrency: 4 });
    const started = await runner.tick();
    expect(started).toHaveLength(1);
    expect(getTask(db, a.id)?.status).toBe("running");
    expect(getTask(db, b.id)?.status).toBe("queued");
    release();
    await Promise.all(started);
    await Promise.all(await runner.tick());
    expect(getTask(db, b.id)?.status).toBe("succeeded");
  });

  it("requeues tasks orphaned by a previous process and fails them after too many attempts", () => {
    const { db, userId } = testDb();
    const old = new Date(Date.now() - 60_000);
    const a = enqueueTask(db, userId, "test-ok", null);
    const b = enqueueTask(db, userId, "test-ok", null);
    db.update(tasks).set({ status: "running", heartbeatAt: old, attempts: 1 }).where(eq(tasks.id, a.id)).run();
    db.update(tasks).set({ status: "running", heartbeatAt: old, attempts: 3 }).where(eq(tasks.id, b.id)).run();
    new TaskRunner(db).recoverStale();
    expect(getTask(db, a.id)?.status).toBe("queued");
    expect(getTask(db, b.id)?.status).toBe("failed");
  });

  it("does not overwrite a cancellation when the handler finishes", async () => {
    const { db, userId } = testDb();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    registerTaskHandler("test-cancel", { run: () => gate });
    const task = enqueueTask(db, userId, "test-cancel", null);
    const started = await new TaskRunner(db).tick();
    cancelTask(db, task.id);
    release();
    await Promise.all(started);
    expect(getTask(db, task.id)?.status).toBe("cancelled");
  });
});
