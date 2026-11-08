import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  boardOpenings,
  chatMessages,
  conversations,
  cvDocuments,
  jobAttachments,
  jobEvents,
  jobSightings,
  jobs,
  postingAnalyses,
  users,
  watchedBoards,
} from "@/server/db/schema";
import { addAttachments, createJob, deleteJob, deleteJobs, getJob } from "@/server/repo/jobs";
import { bulkDeleteJobs, isJsonContentType } from "@/server/jobs/bulk-delete";
import { chunkIds, deletableCount, isInProgress, IN_PROGRESS_STATUSES, JOB_STATUSES, MAX_BULK_DELETE, numberRepeats } from "@/shared/schemas/job";
import { testDb } from "../helpers/db";

type Db = ReturnType<typeof testDb>["db"];

const job = (db: Db, userId: number, status = "new") => createJob(db, userId, { source: "paste", rawText: "A posting", title: "Engineer", status });

describe("bulk delete request validation", () => {
  it.each([
    ["not an array", { ids: 7 }],
    ["empty", { ids: [] }],
    ["too many", { ids: Array.from({ length: MAX_BULK_DELETE + 1 }, (_, i) => i + 1) }],
    ["fraction", { ids: [1.5] }],
    ["negative", { ids: [-1] }],
    ["string id", { ids: ["7"] }],
    ["non-boolean flag", { ids: [1], includeInProgress: "yes" }],
    ["no body", null],
  ])("rejects %s", (_, body) => {
    const { db, userId } = testDb();
    expect(bulkDeleteJobs(db, userId, body)).toEqual({ status: 400, body: { error: "invalid" } });
  });

  it("accepts exactly the maximum", () => {
    const { db, userId } = testDb();
    const res = bulkDeleteJobs(db, userId, { ids: Array.from({ length: MAX_BULK_DELETE }, (_, i) => i + 1) });
    expect(res.status).toBe(200);
  });
});

describe("deleteJobs", () => {
  it("removes the job with its children and keeps shared rows", () => {
    const { db, userId } = testDb();
    const analysis = db.insert(postingAnalyses).values({ textHash: "h", promptVersion: 1, model: "m", effort: "low", data: {} }).returning().get();
    const j = job(db, userId);
    db.update(jobs).set({ analysisId: analysis.id }).where(eq(jobs.id, j.id)).run();
    addAttachments(db, j.id, [{ kind: "screenshot", path: "/tmp/x.png", mime: "image/png", fileName: "x.png" }]);
    const conv = db.insert(conversations).values({ userId, jobId: j.id, model: "m", effort: "low", toolsetVersion: 1, system: "s", tools: [] }).returning().get();
    db.insert(chatMessages).values({ conversationId: conv.id, seq: 0, role: "user", kind: "context", content: [] }).run();
    db.insert(jobSightings).values({ jobId: j.id, source: "adzuna" }).run();
    db.insert(cvDocuments).values({ userId, jobId: j.id, kind: "cv", version: 1, profileVersion: 1, profileHash: "p", language: "en", model: "m", promptVersion: 1, content: {}, flags: [] }).run();
    const watch = db.insert(watchedBoards).values({ userId, name: "Acme", atsType: "greenhouse", board: "acme" }).returning().get();
    const now = new Date();
    const opening = db
      .insert(boardOpenings)
      .values({ watchId: watch.id, externalId: "1", title: "Engineer", url: "https://x", atsUrl: "https://x", firstSeenAt: now, lastSeenAt: now, jobId: j.id })
      .returning()
      .get();

    // Every child exists before the delete, so the zero counts below mean something.
    expect(db.select().from(jobEvents).where(eq(jobEvents.jobId, j.id)).all()).toHaveLength(1);
    expect(db.select().from(jobAttachments).where(eq(jobAttachments.jobId, j.id)).all()).toHaveLength(1);

    expect(bulkDeleteJobs(db, userId, { ids: [j.id] })).toEqual({ status: 200, body: { deleted: [j.id], skipped: [] } });

    expect(getJob(db, userId, j.id)).toBeUndefined();
    expect(db.select().from(jobAttachments).where(eq(jobAttachments.jobId, j.id)).all()).toHaveLength(0);
    expect(db.select().from(jobEvents).where(eq(jobEvents.jobId, j.id)).all()).toHaveLength(0);
    expect(db.select().from(conversations).where(eq(conversations.jobId, j.id)).all()).toHaveLength(0);
    expect(db.select().from(chatMessages).where(eq(chatMessages.conversationId, conv.id)).all()).toHaveLength(0);
    expect(db.select().from(jobSightings).where(eq(jobSightings.jobId, j.id)).all()).toHaveLength(0);
    expect(db.select().from(cvDocuments).where(eq(cvDocuments.jobId, j.id)).all()).toHaveLength(0);
    expect(db.select().from(postingAnalyses).where(eq(postingAnalyses.id, analysis.id)).all()).toHaveLength(1);
    expect(db.select().from(boardOpenings).where(eq(boardOpenings.id, opening.id)).get()?.jobId).toBeNull();
  });

  it("reports per-id results and keeps in-progress jobs unless asked", () => {
    const { db, userId } = testDb();
    const a = job(db, userId);
    const b = job(db, userId, "applied");
    expect(bulkDeleteJobs(db, userId, { ids: [a.id, 999999, b.id] }).body).toEqual({
      deleted: [a.id],
      skipped: [
        { id: 999999, reason: "not_found" },
        { id: b.id, reason: "in_progress" },
      ],
    });
    expect(getJob(db, userId, b.id)).toBeDefined();

    const c = job(db, userId);
    expect(bulkDeleteJobs(db, userId, { ids: [c.id, b.id], includeInProgress: true }).body).toEqual({ deleted: [c.id, b.id], skipped: [] });
    expect(getJob(db, userId, b.id)).toBeUndefined();
  });

  it("collapses duplicate ids", () => {
    const { db, userId } = testDb();
    const a = job(db, userId);
    expect(bulkDeleteJobs(db, userId, { ids: [a.id, a.id] }).body).toEqual({ deleted: [a.id], skipped: [] });
  });

  it("never touches another user's jobs", () => {
    const { db, userId } = testDb();
    const other = db.insert(users).values({ locale: "en" }).returning().get();
    const theirs = job(db, other.id);
    expect(bulkDeleteJobs(db, userId, { ids: [theirs.id] }).body).toEqual({ deleted: [], skipped: [{ id: theirs.id, reason: "not_found" }] });
    expect(getJob(db, other.id, theirs.id)).toBeDefined();
  });

  // One DELETE statement is already atomic in SQLite, so this pins the behaviour, not the transaction itself.
  it("deletes all or nothing", () => {
    const { db, userId } = testDb();
    const a = job(db, userId);
    const b = job(db, userId);
    db.run(sql.raw(`CREATE TRIGGER fail_second BEFORE DELETE ON jobs WHEN OLD.id = ${b.id} BEGIN SELECT RAISE(ABORT, 'boom'); END;`));
    expect(() => deleteJobs(db, userId, [a.id, b.id], { includeInProgress: true })).toThrow();
    expect(getJob(db, userId, a.id)).toBeDefined();
  });

  it("single delete still removes a job in progress", () => {
    const { db, userId } = testDb();
    const a = job(db, userId, "applied");
    deleteJob(db, userId, a.id);
    expect(getJob(db, userId, a.id)).toBeUndefined();
  });
});

describe("bulk delete helpers", () => {
  it("counts what will actually be deleted", () => {
    const sel = [{ inProgress: false }, { inProgress: true }];
    expect(deletableCount(sel, false)).toBe(1);
    expect(deletableCount(sel, true)).toBe(2);
  });

  it("chunks ids by the request cap", () => {
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    expect(chunkIds(ids).map((c) => c.length)).toEqual([500, 500, 1]);
    expect(chunkIds(ids).flat()).toEqual(ids);
    expect(chunkIds([])).toEqual([]);
  });

  it("numbers repeated row names so each checkbox has its own name", () => {
    expect(numberRepeats(["a", "b", "a", "a"])).toEqual([
      { n: 1, count: 3 },
      { n: 1, count: 1 },
      { n: 2, count: 3 },
      { n: 3, count: 3 },
    ]);
    expect(numberRepeats([])).toEqual([]);
  });

  it("marks exactly applying, applied, interviewing and offer as in progress", () => {
    const expected = ["applying", "applied", "interviewing", "offer"];
    expect([...IN_PROGRESS_STATUSES]).toEqual(expected);
    for (const status of JOB_STATUSES) expect(isInProgress(status), status).toBe(expected.includes(status));
  });
});

describe("isJsonContentType", () => {
  it.each([
    ["application/json", true],
    ["application/json; charset=utf-8", true],
    ["Application/JSON ; charset=UTF-8", true],
    ["text/plain; x=application/json", false],
    ["text/plain", false],
    ["application/jsonx", false],
    ["application/json-patch+json", false],
    ["", false],
    [null, false],
  ])("%s → %s", (header, expected) => {
    expect(isJsonContentType(header)).toBe(expected);
  });
});
