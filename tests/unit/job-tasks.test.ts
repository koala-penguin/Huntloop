import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createJob, getJob, upsertCompany } from "@/server/repo/jobs";
import { findOnEmployerSite, reassessJob } from "@/server/jobs/intake";
import { jobTaskRefs } from "@/server/jobs/job-tasks";
import { startCompanyResearch } from "@/server/research/company";
import { enqueueTask } from "@/server/tasks/runner";
import { TAILOR_CV_TASK } from "@/server/tasks/handlers/tailor-cv";
import { tasks } from "@/server/db/schema";
import { fakeDelayMs, fakeFails } from "@/server/ai/fake/transport";
import { testDb } from "../helpers/db";

function setup() {
  const { db, userId } = testDb();
  const companyId = upsertCompany(db, userId, { name: "Tidal Systems" });
  const job = createJob(db, userId, { source: "paste", rawText: "A posting", intakeStatus: "ready", companyId, companyName: "Tidal Systems", title: "Engineer", analysisId: 1 });
  const finish = (id: number, status: "succeeded" | "failed" = "succeeded") => db.update(tasks).set({ status }).where(eq(tasks.id, id)).run();
  return { db, userId, job, finish };
}

describe("jobTaskRefs", () => {
  it("is empty for a job without tasks", () => {
    const { db, userId, job } = setup();
    const none = { active: null, latest: null, latestStatus: null };
    expect(jobTaskRefs(db, userId, job)).toEqual({ intake: none, research: none, findEmployer: none, tailoring: none });
  });

  it("reports the running task and keeps the newest one after it finishes", () => {
    const { db, userId, job, finish } = setup();
    const research = startCompanyResearch(db, userId, job, { simulated: true });
    const find = findOnEmployerSite(db, userId, job.id);
    const assess = reassessJob(db, userId, job.id);
    const tailor = enqueueTask(db, userId, TAILOR_CV_TASK, { jobId: job.id }).id;
    expect(research.ok && research.taskId).toBeTruthy();
    const researchId = research.ok ? research.taskId : null;

    expect(jobTaskRefs(db, userId, job)).toEqual({
      intake: { active: assess, latest: assess, latestStatus: "queued" },
      research: { active: researchId, latest: researchId, latestStatus: "queued" },
      findEmployer: { active: find, latest: find, latestStatus: "queued" },
      tailoring: { active: tailor, latest: tailor, latestStatus: "queued" },
    });

    for (const id of [researchId!, find, assess, tailor]) finish(id);
    expect(jobTaskRefs(db, userId, job)).toEqual({
      intake: { active: null, latest: assess, latestStatus: "succeeded" },
      research: { active: null, latest: researchId, latestStatus: "succeeded" },
      findEmployer: { active: null, latest: find, latestStatus: "succeeded" },
      tailoring: { active: null, latest: tailor, latestStatus: "succeeded" },
    });
  });

  it("says how the newest task ended", () => {
    const { db, userId, job, finish } = setup();
    const first = reassessJob(db, userId, job.id);
    finish(first);
    const second = reassessJob(db, userId, job.id);
    finish(second, "failed");
    expect(jobTaskRefs(db, userId, job).intake).toEqual({ active: null, latest: second, latestStatus: "failed" });
  });

  it("follows research for the job's employer, started from any of its jobs", () => {
    const { db, userId, job } = setup();
    const other = createJob(db, userId, { source: "paste", rawText: "Another", companyId: job.companyId, companyName: "Tidal Systems" });
    const research = startCompanyResearch(db, userId, other, { simulated: true });
    const id = research.ok ? research.taskId : null;
    expect(jobTaskRefs(db, userId, getJob(db, userId, job.id)!).research).toEqual({ active: id, latest: id, latestStatus: "queued" });
  });
});

describe("starting a task that is already running", () => {
  it("reassessing returns the job's running task instead of queueing another", () => {
    const { db, userId, job, finish } = setup();
    const first = reassessJob(db, userId, job.id);
    expect(reassessJob(db, userId, job.id)).toBe(first);
    finish(first);
    expect(reassessJob(db, userId, job.id)).not.toBe(first);
  });

  it("finding on the employer's site returns the running task", () => {
    const { db, userId, job } = setup();
    expect(findOnEmployerSite(db, userId, job.id)).toBe(findOnEmployerSite(db, userId, job.id));
  });
});

describe("fakeDelayMs (test-only demo slow-down)", () => {
  const body = { model: "m", messages: [{ role: "user", content: "Employer: Slowpoke Ltd" }] };
  it("is off unless configured", () => {
    expect(fakeDelayMs("companyResearch", body, undefined)).toBe(0);
    expect(fakeDelayMs("companyResearch", body, "nonsense")).toBe(0);
  });
  it("delays only the listed tasks whose request mentions the marker", () => {
    const spec = "Slowpoke:companyResearch,browserAgent=8000";
    expect(fakeDelayMs("companyResearch", body, spec)).toBe(8000);
    expect(fakeDelayMs("browserAgent", body, spec)).toBe(8000);
    expect(fakeDelayMs("assess", body, spec)).toBe(0);
    expect(fakeDelayMs("companyResearch", { ...body, messages: [{ role: "user", content: "Employer: Tidal" }] }, spec)).toBe(0);
  });
  it("takes several rules", () => {
    const spec = "Sloth:assess=3000;Slowpoke:companyResearch=8000";
    expect(fakeDelayMs("companyResearch", body, spec)).toBe(8000);
    expect(fakeDelayMs("assess", body, spec)).toBe(0);
    expect(fakeDelayMs("assess", { ...body, messages: [{ role: "user", content: "Sloth Ltd" }] }, spec)).toBe(3000);
  });
  it("fails only the listed tasks whose request mentions the marker", () => {
    expect(fakeFails("companyResearch", body, undefined)).toBe(false);
    expect(fakeFails("companyResearch", body, "Slowpoke:companyResearch")).toBe(true);
    expect(fakeFails("assess", body, "Slowpoke:companyResearch")).toBe(false);
    expect(fakeFails("companyResearch", body, "Doomed:companyResearch")).toBe(false);
  });
});
