import { and, asc, desc, eq, inArray, lt, notInArray } from "drizzle-orm";
import type { Db } from "../db/database";
import { tasks, type TaskRow } from "../db/schema";
import { formatTaskError } from "../errors";

export type TaskStatus = "queued" | "running" | "needs_user_action" | "succeeded" | "failed" | "cancelled";

export interface TaskContext {
  db: Db;
  task: TaskRow;
  userId: number;
  payload: unknown;
  signal: AbortSignal;
  /** Persist progress for the UI (throttled). */
  progress: (value: unknown) => void;
  /**
   * Pause until the user deals with something (a CAPTCHA, a login) and presses Continue, or skips
   * it. Polls `isResolved` meanwhile. Throws if the task is cancelled. Absent outside the runner.
   */
  waitForUser?: (reason: UserActionReason, isResolved: () => Promise<boolean>) => Promise<"resolved" | "skipped">;
}

export interface UserActionReason {
  /** e.g. "captcha", "login", "checkpoint" */
  kind: string;
  /** e.g. "seek", "linkedin" */
  site?: string | null;
  url?: string | null;
}

export class TaskCancelledError extends Error {
  constructor() {
    super("Task cancelled");
    this.name = "TaskCancelledError";
  }
}

export interface TaskHandlerDefinition {
  run: (ctx: TaskContext) => Promise<unknown>;
  /** Tasks in the same group never run at the same time (e.g. "browser"). */
  exclusiveGroup?: string;
  maxAttempts?: number;
  /** Called when recoverStale gives up on a task left running by a previous process. */
  onAbandoned?: (db: Db, task: TaskRow) => void;
}

const handlers = new Map<string, TaskHandlerDefinition>();

export function registerTaskHandler(kind: string, definition: TaskHandlerDefinition): void {
  handlers.set(kind, definition);
}

export function enqueueTask(db: Db, userId: number, kind: string, payload: unknown, parentId?: number): TaskRow {
  return db.insert(tasks).values({ userId, kind, payload, parentId: parentId ?? null }).returning().get();
}

export function getTask(db: Db, id: number): TaskRow | undefined {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

export function listTasks(db: Db, userId: number, kind?: string, limit = 20): TaskRow[] {
  return db
    .select()
    .from(tasks)
    .where(kind ? and(eq(tasks.userId, userId), eq(tasks.kind, kind)) : eq(tasks.userId, userId))
    .orderBy(desc(tasks.createdAt))
    .limit(limit)
    .all();
}

/** The user's answer to a paused task: carry on (after fixing it in the browser) or skip that step. */
export function answerTask(db: Db, id: number, action: "continue" | "skip"): boolean {
  const row = db
    .update(tasks)
    .set({ userAction: action })
    .where(and(eq(tasks.id, id), eq(tasks.status, "needs_user_action")))
    .returning()
    .get();
  return !!row;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Implementation of TaskContext.waitForUser for a task row. The progress shown to the UI gains an
 * `action` describing what the user needs to do.
 */
export async function waitForUserOnTask(
  db: Db,
  taskId: number,
  reason: UserActionReason,
  isResolved: () => Promise<boolean>,
  options: { signal?: AbortSignal; pollMs?: number; currentProgress?: unknown } = {},
): Promise<"resolved" | "skipped"> {
  const progress = { ...((options.currentProgress as object | undefined) ?? {}), action: reason };
  db.update(tasks).set({ status: "needs_user_action", userAction: null, progress }).where(and(eq(tasks.id, taskId), eq(tasks.status, "running"))).run();
  const back = (result: "resolved" | "skipped") => {
    const { action: _drop, ...rest } = progress;
    void _drop;
    db.update(tasks).set({ status: "running", userAction: null, progress: rest }).where(and(eq(tasks.id, taskId), eq(tasks.status, "needs_user_action"))).run();
    return result;
  };
  for (;;) {
    const current = getTask(db, taskId);
    if (!current || current.status === "cancelled" || options.signal?.aborted) throw new TaskCancelledError();
    if (current.userAction === "skip") return back("skipped");
    if (current.userAction === "continue" || (await isResolved().catch(() => false))) return back("resolved");
    await sleep(options.pollMs ?? 2_000, options.signal);
  }
}

export function cancelTask(db: Db, id: number): void {
  db.update(tasks)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(tasks.id, id), inArray(tasks.status, ["queued", "running", "needs_user_action"])))
    .run();
}

const HEARTBEAT_MS = 5_000;
const STALE_AFTER_MS = 30_000;

export interface RunnerOptions {
  pollMs?: number;
  concurrency?: number;
}

/** In-process worker that executes queued tasks from the database. */
export class TaskRunner {
  private timer: NodeJS.Timeout | undefined;
  /** Tasks this runner is executing; `waiting` ones are paused for the user and don't use a slot. */
  private running = new Map<number, { controller: AbortController; group?: string; waiting: boolean }>();
  private ticking = false;
  private lastRecoverAt = 0;

  constructor(
    private readonly db: Db,
    private readonly options: RunnerOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.recoverStale();
    this.timer = setInterval(() => void this.tick(), this.options.pollMs ?? 500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const { controller } of this.running.values()) controller.abort();
  }

  /**
   * Tasks left "running" with a stale heartbeat (by a previous process, or one that stopped
   * heart-beating) go back to the queue, or fail after max attempts. Runs at start and then every
   * STALE_AFTER_MS from tick(); tasks this runner is executing itself are never touched.
   */
  recoverStale(now = Date.now()): void {
    this.lastRecoverAt = now;
    const mine = [...this.running.keys()];
    const stale = this.db
      .select()
      .from(tasks)
      .where(
        and(
          inArray(tasks.status, ["running", "needs_user_action"]),
          lt(tasks.heartbeatAt, new Date(now - STALE_AFTER_MS)),
          mine.length ? notInArray(tasks.id, mine) : undefined,
        ),
      )
      .all();
    for (const task of stale) {
      const definition = handlers.get(task.kind);
      const max = definition?.maxAttempts ?? 3;
      const giveUp = task.attempts >= max;
      this.db
        .update(tasks)
        .set(giveUp ? { status: "failed", error: "Interrupted too many times", finishedAt: new Date() } : { status: "queued", userAction: null })
        .where(eq(tasks.id, task.id))
        .run();
      if (giveUp) {
        try {
          definition?.onAbandoned?.(this.db, task);
        } catch (error) {
          console.error("[huntloop] onAbandoned", error);
        }
      }
    }
  }

  /** Starts as many queued tasks as allowed. Returns the promises of tasks started (for tests). */
  async tick(): Promise<Promise<void>[]> {
    if (this.ticking) return [];
    this.ticking = true;
    const started: Promise<void>[] = [];
    try {
      const now = Date.now();
      if (now - this.lastRecoverAt >= STALE_AFTER_MS) this.recoverStale(now);
      const limit = this.options.concurrency ?? 2;
      const busy = () => [...this.running.values()].filter((r) => !r.waiting).length;
      while (busy() < limit) {
        const claimed = this.claimNext();
        if (!claimed) break;
        started.push(this.execute(claimed.task, claimed.definition));
      }
    } finally {
      this.ticking = false;
    }
    return started;
  }

  private claimNext(): { task: TaskRow; definition: TaskHandlerDefinition } | undefined {
    const busyGroups = new Set([...this.running.values()].map((r) => r.group).filter(Boolean));
    return this.db.transaction((tx) => {
      const queued = tx.select().from(tasks).where(eq(tasks.status, "queued")).orderBy(asc(tasks.createdAt)).limit(25).all();
      for (const task of queued) {
        const definition = handlers.get(task.kind);
        if (!definition) {
          tx.update(tasks).set({ status: "failed", error: `No handler for task kind "${task.kind}"`, finishedAt: new Date() }).where(eq(tasks.id, task.id)).run();
          continue;
        }
        if (definition.exclusiveGroup && busyGroups.has(definition.exclusiveGroup)) continue;
        const now = new Date();
        const row = tx
          .update(tasks)
          .set({ status: "running", attempts: task.attempts + 1, startedAt: now, heartbeatAt: now, error: null })
          .where(and(eq(tasks.id, task.id), eq(tasks.status, "queued")))
          .returning()
          .get();
        if (row) return { task: row, definition };
      }
      return undefined;
    });
  }

  private async execute(task: TaskRow, definition: TaskHandlerDefinition): Promise<void> {
    const controller = new AbortController();
    const entry = { controller, group: definition.exclusiveGroup, waiting: false };
    this.running.set(task.id, entry);
    let lastProgressWrite = 0;
    let pendingProgress: unknown;
    const writeProgress = () => {
      lastProgressWrite = Date.now();
      this.db.update(tasks).set({ progress: pendingProgress }).where(eq(tasks.id, task.id)).run();
    };
    const heartbeat = setInterval(() => {
      const current = getTask(this.db, task.id);
      if (!current || current.status === "cancelled") controller.abort();
      else this.db.update(tasks).set({ heartbeatAt: new Date() }).where(eq(tasks.id, task.id)).run();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    try {
      const result = await definition.run({
        db: this.db,
        task,
        userId: task.userId,
        payload: task.payload,
        signal: controller.signal,
        progress: (value) => {
          pendingProgress = value;
          if (Date.now() - lastProgressWrite > 250) writeProgress();
        },
        waitForUser: async (reason, isResolved) => {
          if (pendingProgress !== undefined) writeProgress();
          entry.waiting = true;
          try {
            return await waitForUserOnTask(this.db, task.id, reason, isResolved, { signal: controller.signal, currentProgress: pendingProgress });
          } finally {
            entry.waiting = false;
          }
        },
      });
      if (pendingProgress !== undefined) writeProgress();
      this.finish(task.id, { status: "succeeded", result: result ?? null });
    } catch (error) {
      if (pendingProgress !== undefined) writeProgress();
      const cancelled = getTask(this.db, task.id)?.status === "cancelled";
      if (!cancelled) {
        this.finish(task.id, { status: "failed", error: formatTaskError(error) });
      }
    } finally {
      clearInterval(heartbeat);
      this.running.delete(task.id);
    }
  }

  private finish(id: number, values: { status: TaskStatus; result?: unknown; error?: string }): void {
    this.db
      .update(tasks)
      .set({ ...values, finishedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.status, "running")))
      .run();
  }
}

const globalRunner = globalThis as unknown as { huntloopRunner?: TaskRunner };

export function startTaskRunner(db: Db): TaskRunner {
  if (!globalRunner.huntloopRunner) {
    globalRunner.huntloopRunner = new TaskRunner(db);
    globalRunner.huntloopRunner.start();
  }
  return globalRunner.huntloopRunner;
}
