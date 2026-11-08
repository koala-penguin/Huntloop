import { describe, expect, it } from "vitest";
import { createJob, getJob, setJobStatus, updateJob } from "@/server/repo/jobs";
import { jobHistory, outcomeStats, pipelineBoard } from "@/server/pipeline/outcomes";
import { testDb } from "../helpers/db";

const DAY = 86_400_000;

function job(db: ReturnType<typeof testDb>["db"], userId: number, tier: string | null, title = "Frontend Engineer") {
  const row = createJob(db, userId, { source: "paste", title, companyName: "Acme" });
  return updateJob(db, row.id, { tier, score: tier ? 70 : null, eligibility: "eligible" });
}

describe("pipeline", () => {
  it("records outcomes with a tier snapshot, the applied date and when the stage changed", () => {
    const { db, userId } = testDb();
    const j = job(db, userId, "good");
    setJobStatus(db, userId, j.id, "applied", undefined, { date: "2026-09-01", channel: "referral", round: null, stage: null, note: "Via Sam" });
    const after = getJob(db, userId, j.id)!;
    expect(after.appliedAt!.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(after.statusChangedAt).toBeInstanceOf(Date);
    const status = jobHistory(db, j.id).find((e) => e.type === "status")!;
    expect(status).toMatchObject({ from: "new", to: "applied", data: { snapshot: { tier: "good", score: 70 }, outcome: { channel: "referral", note: "Via Sam" } } });

    // The applied date is kept when the job moves on.
    setJobStatus(db, userId, j.id, "interviewing", undefined, { date: "2026-09-20", channel: null, round: "Phone screen", stage: null, note: null });
    expect(getJob(db, userId, j.id)!.appliedAt!.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("groups jobs by stage and suggests a follow-up after two quiet weeks", () => {
    const { db, userId } = testDb();
    const a = job(db, userId, "strong", "A");
    const b = job(db, userId, "good", "B");
    job(db, userId, null, "C");
    setJobStatus(db, userId, a.id, "applied");
    setJobStatus(db, userId, b.id, "rejected", undefined, { date: null, channel: null, round: null, stage: "no_response", note: null });
    const soon = pipelineBoard(db, userId, new Date(Date.now() + 3 * DAY));
    expect(soon.columns.applied.map((c) => [c.title, c.daysInStage, c.followUp])).toEqual([["A", 3, false]]);
    expect(soon.counts).toEqual({ new: 1, rejected: 1, archived: 0 });
    expect(pipelineBoard(db, userId, new Date(Date.now() + 15 * DAY)).columns.applied[0].followUp).toBe(true);
  });

  it("shows how the tier at application time turned into interviews and offers", () => {
    const { db, userId } = testDb();
    const strong1 = job(db, userId, "strong");
    const strong2 = job(db, userId, "strong");
    const stretch = job(db, userId, "stretch");
    const recruiter = job(db, userId, "good");
    for (const j of [strong1, strong2, stretch]) setJobStatus(db, userId, j.id, "applied");
    setJobStatus(db, userId, strong1.id, "interviewing");
    setJobStatus(db, userId, strong1.id, "offer");
    setJobStatus(db, userId, stretch.id, "rejected", undefined, { date: null, channel: null, round: null, stage: "after_interview", note: null });
    // A recruiter reached out: straight to interviewing counts as an application too.
    setJobStatus(db, userId, recruiter.id, "interviewing");
    // Re-tiering after applying doesn't rewrite history.
    updateJob(db, strong2.id, { tier: "long_shot" });

    expect(outcomeStats(db, userId)).toEqual([
      { tier: "strong", applied: 2, interviews: 1, offers: 1 },
      { tier: "good", applied: 1, interviews: 1, offers: 0 },
      { tier: "stretch", applied: 1, interviews: 1, offers: 0 },
    ]);
  });
});
