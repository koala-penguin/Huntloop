import { describe, expect, it } from "vitest";
import { addAttachments, createJob, getJob } from "@/server/repo/jobs";
import { canRetryIntake, retryIntake } from "@/server/jobs/intake";
import { getTask } from "@/server/tasks/runner";
import { PROCESS_JOB_TASK } from "@/server/tasks/handlers/process-job";
import { testDb } from "../helpers/db";

const shot = { kind: "image", mime: "image/png", path: "postings/shot.png", fileName: "shot.png" };
const failed = { intakeStatus: "failed", intakeError: "[overloaded] Overloaded" } as const;

describe("retryIntake", () => {
  it("re-runs intake on the stored posting text", () => {
    const { db, userId } = testDb();
    const job = createJob(db, userId, { source: "paste", rawText: "A posting", ...failed });
    expect(canRetryIntake(job, 0)).toBe(true);

    const taskId = retryIntake(db, userId, job.id);
    const task = getTask(db, taskId)!;
    expect(task.kind).toBe(PROCESS_JOB_TASK);
    expect(task.payload).toEqual({ jobId: job.id });
    const updated = getJob(db, userId, job.id)!;
    expect(updated.intakeStatus).toBe("processing");
    expect(updated.intakeError).toBeNull();
  });

  it("reads the link again when there's no text", () => {
    const { db, userId } = testDb();
    const job = createJob(db, userId, { source: "url", sourceUrl: "https://example.com/job/1", ...failed });
    expect(getTask(db, retryIntake(db, userId, job.id))!.payload).toEqual({ jobId: job.id, preferUrl: true });
  });

  it("re-transcribes uploaded files when there's no text", () => {
    const { db, userId } = testDb();
    const job = createJob(db, userId, { source: "screenshot", ...failed });
    addAttachments(db, job.id, [shot]);
    expect(canRetryIntake(job, 1)).toBe(true);
    expect(getTask(db, retryIntake(db, userId, job.id))!.payload).toEqual({ jobId: job.id, transcribe: true });
  });

  it("re-transcribes files whose transcription never landed, even with pasted text", () => {
    const { db, userId } = testDb();
    const job = createJob(db, userId, { source: "screenshot", rawText: "short", ...failed });
    addAttachments(db, job.id, [shot]);
    expect(getTask(db, retryIntake(db, userId, job.id))!.payload).toEqual({ jobId: job.id, transcribe: true });
  });

  it("re-runs on the stored text once the files were transcribed into it", () => {
    const { db, userId } = testDb();
    const job = createJob(db, userId, { source: "screenshot", rawText: "Pasted\n\nTranscribed", intake: { transcribed: true }, ...failed });
    addAttachments(db, job.id, [shot]);
    expect(getTask(db, retryIntake(db, userId, job.id))!.payload).toEqual({ jobId: job.id });
  });

  it("returns the intake task already running instead of queueing another", () => {
    const { db, userId } = testDb();
    const job = createJob(db, userId, { source: "paste", rawText: "A posting", ...failed });
    const first = retryIntake(db, userId, job.id);
    expect(retryIntake(db, userId, job.id)).toBe(first);
  });

  it("only retries a failed intake", () => {
    const { db, userId } = testDb();
    const job = createJob(db, userId, { source: "paste", rawText: "A posting", intakeStatus: "ready" });
    expect(() => retryIntake(db, userId, job.id)).toThrow("invalid");
  });

  it("refuses a missing job or one with nothing to work from", () => {
    const { db, userId } = testDb();
    expect(() => retryIntake(db, userId, 999)).toThrow("not_found");
    const empty = createJob(db, userId, { source: "paste", ...failed });
    expect(canRetryIntake(empty, 0)).toBe(false);
    expect(() => retryIntake(db, userId, empty.id)).toThrow("missing_posting");
  });
});
