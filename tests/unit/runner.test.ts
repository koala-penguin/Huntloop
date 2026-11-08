import { eq } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { tasks } from "@/server/db/schema";
import { cancelTask, enqueueTask, getTask, registerTaskHandler, TaskRunner } from "@/server/tasks/runner";
import { createJob, getJob } from "@/server/repo/jobs";
import { failOrphanedProcessingJobs, PROCESS_JOB_TASK } from "@/server/tasks/handlers/process-job";
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

  it("requeues a task another process left running, once its heartbeat is stale", async () => {
    vi.useFakeTimers();
    try {
      const { db, userId } = testDb();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      registerTaskHandler("test-stale", { run: () => gate });
      const task = enqueueTask(db, userId, "test-stale", null);
      db.update(tasks).set({ status: "running", heartbeatAt: new Date(Date.now() - 10_000), attempts: 1 }).where(eq(tasks.id, task.id)).run();
      const runner = new TaskRunner(db);
      runner.start();
      expect(getTask(db, task.id)).toMatchObject({ status: "running", attempts: 1 });
      vi.setSystemTime(Date.now() + 31_000);
      const started = await runner.tick();
      expect(started).toHaveLength(1);
      expect(getTask(db, task.id)).toMatchObject({ status: "running", attempts: 2 });
      release();
      await Promise.all(started);
      runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never recovers a task it is running itself", async () => {
    vi.useFakeTimers();
    try {
      const { db, userId } = testDb();
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      registerTaskHandler("test-own", { run: () => gate });
      const task = enqueueTask(db, userId, "test-own", null);
      const runner = new TaskRunner(db);
      const started = await runner.tick();
      expect(getTask(db, task.id)).toMatchObject({ status: "running", attempts: 1 });
      vi.setSystemTime(Date.now() + 31_000);
      await runner.tick();
      expect(getTask(db, task.id)).toMatchObject({ status: "running", attempts: 1 });
      release();
      await Promise.all(started);
      expect(getTask(db, task.id)?.status).toBe("succeeded");
      runner.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tasks waiting for the user don't take up a slot", async () => {
    const { db, userId } = testDb();
    registerTaskHandler("test-wait", { run: (ctx) => ctx.waitForUser!({ kind: "captcha", site: "seek" }, async () => false) });
    registerTaskHandler("test-free", { run: async () => "done" });
    const a = enqueueTask(db, userId, "test-wait", null);
    const b = enqueueTask(db, userId, "test-wait", null);
    const c = enqueueTask(db, userId, "test-free", null);
    const runner = new TaskRunner(db, { concurrency: 2 });
    const started = await runner.tick();
    await vi.waitFor(() => {
      expect(getTask(db, a.id)?.status).toBe("needs_user_action");
      expect(getTask(db, b.id)?.status).toBe("needs_user_action");
    });
    started.push(...(await runner.tick()));
    await vi.waitFor(() => expect(getTask(db, c.id)?.status).toBe("succeeded"));
    runner.stop();
    await Promise.allSettled(started);
  });

  it("calls onAbandoned when it gives up on a task", () => {
    const { db, userId } = testDb();
    const job = createJob(db, userId, { source: "paste", rawText: "x", intakeStatus: "processing" });
    const task = enqueueTask(db, userId, PROCESS_JOB_TASK, { jobId: job.id });
    db.update(tasks).set({ status: "running", heartbeatAt: new Date(Date.now() - 60_000), attempts: 1 }).where(eq(tasks.id, task.id)).run();
    new TaskRunner(db).recoverStale();
    expect(getTask(db, task.id)?.status).toBe("failed");
    const after = getJob(db, userId, job.id)!;
    expect(after.intakeStatus).toBe("failed");
    expect(after.intakeError).toMatch(/^\[interrupted\]/);
  });

  it("fails jobs left processing with no task behind them at startup", () => {
    const { db, userId } = testDb();
    const orphan = createJob(db, userId, { source: "paste", rawText: "a", intakeStatus: "processing" });
    const queued = createJob(db, userId, { source: "paste", rawText: "b", intakeStatus: "processing" });
    enqueueTask(db, userId, PROCESS_JOB_TASK, { jobId: queued.id });
    expect(failOrphanedProcessingJobs(db)).toBe(1);
    expect(getJob(db, userId, orphan.id)).toMatchObject({ intakeStatus: "failed" });
    expect(getJob(db, userId, orphan.id)!.intakeError).toMatch(/^\[interrupted\]/);
    expect(getJob(db, userId, queued.id)).toMatchObject({ intakeStatus: "processing" });
  });
});
