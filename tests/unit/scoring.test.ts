import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scoreJob } from "@/server/scoring/aggregate";
import { buildQuoteIndex, quoteFound, sliceBetweenAnchors } from "@/server/scoring/quotes";
import { tierRank } from "@/server/scoring/rubric";
import { ASSESSMENT_STATUSES, type AssessmentStatus } from "@/shared/schemas/job";
import { analysis, assessment, profile, req, right, scoreInput } from "../helpers/scoring";

describe("quote verification", () => {
  const index = buildQuoteIndex("Built checkout flows for e-\ncommerce brands.\n• Led   “growth” squad", "도메인 지식: 결제 시스템 설계");
  it("tolerates whitespace, hyphenation, smart quotes and bullets", () => {
    expect(quoteFound("Built checkout flows for ecommerce brands", index)).toBe(true);
    expect(quoteFound("built checkout flows for e-commerce brands.", index)).toBe(true);
    expect(quoteFound('Led "growth" squad', index)).toBe(true);
    expect(quoteFound("결제 시스템 설계", index)).toBe(true);
  });
  it("accepts ellipses only when every part appears in order", () => {
    expect(quoteFound("Built checkout … growth squad", index)).toBe(true);
    expect(quoteFound("growth squad … Built checkout", index)).toBe(false);
  });
  it("rejects changed words and tiny fragments", () => {
    expect(quoteFound("Built payment flows for ecommerce brands", index)).toBe(false);
    expect(quoteFound("Le", index)).toBe(false);
  });
  it("slices a posting out of a noisy paste using verbatim anchors", () => {
    const paste = "Home Jobs Sign in\nSenior Engineer\nWe build things.\nApply now\nSimilar jobs: Junior Engineer";
    expect(sliceBetweenAnchors(paste, "Senior Engineer", "Apply now")).toBe("Senior Engineer\nWe build things.\nApply now");
    expect(sliceBetweenAnchors(paste, "Senior   Engineer", "build things.")).toBe("Senior Engineer\nWe build things.");
    expect(sliceBetweenAnchors(paste, "Not there", "Apply now")).toBeNull();
  });
});

describe("Interview Chance — golden scenarios", () => {
  const strongReqs = [req("r1", { normalized: "React" }), req("r2", { normalized: "TypeScript" }), req("r3", { kind: "nice", normalized: "GraphQL" })];

  it("rates a well-matched, fresh posting as Strong and eligible", () => {
    const result = scoreJob(scoreInput(analysis(strongReqs), assessment({ r1: "met", r2: "met", r3: "partial" }), { postedAt: new Date("2026-10-10T00:00:00Z") }));
    expect(result.eligibility).toBe("eligible");
    expect(result.tier).toBe("strong");
    expect(result.adjustments).toContainEqual({ kind: "fresh", points: 5 });
    expect(result.confidence).toBe("high");
  });

  it("makes an AU government role needing citizenship + Baseline Ineligible for a 482 holder, quoting the posting", () => {
    const a = analysis([
      req("g1", { kind: "gate", category: "work_rights", gate: "citizenship", postingQuote: "Applicants must be Australian citizens" }),
      req("g2", { kind: "gate", category: "clearance", gate: "clearance", postingQuote: "ability to obtain and maintain a Baseline security clearance", normalized: "Baseline clearance" }),
      ...strongReqs,
    ]);
    const result = scoreJob(scoreInput(a, assessment({ r1: "met", r2: "met", r3: "met" }), { profile: profile({}, [right("AU", "needs_sponsorship", "au_482")]) }));
    expect(result.eligibility).toBe("ineligible");
    expect(result.gates).toContainEqual(expect.objectContaining({ kind: "citizenship", status: "fail", postingQuote: "Applicants must be Australian citizens" }));
    expect(result.gates).toContainEqual(expect.objectContaining({ kind: "clearance", status: "fail", reasonKey: "clearance_needs_citizenship" }));
  });

  it("makes a US 'no sponsorship' posting Ineligible for a user who needs sponsorship", () => {
    const a = analysis(strongReqs, { country: "US", city: "Seattle", sponsorship: "not_offered", sponsorshipQuote: "We are unable to sponsor visas" });
    const result = scoreJob(scoreInput(a, assessment({ r1: "met", r2: "met", r3: "met" }), { profile: profile({}, [right("US", "needs_sponsorship", "us_needs_sponsorship")]) }));
    expect(result.eligibility).toBe("ineligible");
    expect(result.gates[0]).toMatchObject({ status: "fail", reasonKey: "sponsorship_needed", postingQuote: "We are unable to sponsor visas" });
  });

  it("asks to verify a Singapore posting when SG work rights aren't set", () => {
    const a = analysis(strongReqs, { country: "SG", city: "Singapore" });
    const result = scoreJob(scoreInput(a, assessment({ r1: "met", r2: "met", r3: "met" })));
    expect(result.eligibility).toBe("verify");
    expect(result.gates).toContainEqual(expect.objectContaining({ kind: "work_rights", status: "unclear", reasonKey: "work_rights_unknown", params: { country: "SG" } }));
    expect(result.gates).toContainEqual(expect.objectContaining({ kind: "location", reasonKey: "outside_markets" }));
  });

  it("re-tiers instantly when the user answers the work-rights question (no AI involved)", () => {
    const a = analysis(strongReqs, { country: "SG", city: "Singapore" });
    const as = assessment({ r1: "met", r2: "met", r3: "met" });
    const before = scoreJob(scoreInput(a, as));
    const after = scoreJob(scoreInput(a, as, { profile: profile({}, [right("AU", "permanent_resident"), right("SG", "permanent_resident", "sg_pr")]), preferences: { ...scoreInput(a, as).preferences, willingToRelocate: true } }));
    expect(before.eligibility).toBe("verify");
    expect(after.eligibility).toBe("eligible");
  });

  it("treats 'met' without a verifiable CV quote as unknown", () => {
    const as = assessment({ r1: "met", r2: "met", r3: "met" });
    as.items[0].evidence = [{ source: "cv", quote: "Ran Kubernetes clusters at Google", factId: null }];
    const result = scoreJob(scoreInput(analysis(strongReqs), as));
    expect(result.items[0]).toMatchObject({ status: "unknown", droppedEvidence: 1 });
  });

  it("decides years requirements by arithmetic, ignoring the model's label", () => {
    // 2018-01 → today is ~8.8 years: 9 required → partial (within a year), 11 required → unmet.
    const a = analysis([req("y1", { category: "years", minYears: 9, normalized: "9+ years" }), ...strongReqs]);
    const as = assessment({ y1: "met", r1: "met", r2: "met", r3: "met" });
    const result = scoreJob(scoreInput(a, as));
    expect(result.candidateYears).toBeGreaterThan(8);
    expect(result.items.find((i) => i.requirementId === "y1")?.status).toBe("partial");
    const longer = scoreJob(scoreInput(analysis([req("y1", { category: "years", minYears: 11 }), ...strongReqs]), as));
    expect(longer.items.find((i) => i.requirementId === "y1")?.status).toBe("unmet");
    expect(longer.capsApplied.map((c) => c.reasonKey)).toContain("years_short");
  });

  it("caps the tier at Good with one unmet must-have and at Stretch with two", () => {
    const reqs = [req("m1"), req("m2"), req("m3"), req("m4"), req("m5"), req("m6")];
    const one = scoreJob(scoreInput(analysis(reqs), assessment({ m1: "unmet", m2: "met", m3: "met", m4: "met", m5: "met", m6: "met" })));
    const two = scoreJob(scoreInput(analysis(reqs), assessment({ m1: "unmet", m2: "unmet", m3: "met", m4: "met", m5: "met", m6: "met" })));
    expect(one.capsApplied.map((c) => c.reasonKey)).toContain("unmet_must");
    expect(tierRank(one.tier)).toBeLessThanOrEqual(tierRank("good"));
    expect(two.capsApplied.map((c) => c.reasonKey)).toContain("two_unmet_musts");
    expect(tierRank(two.tier)).toBeLessThanOrEqual(tierRank("stretch"));
  });

  it("applies the user's Yes/No answers", () => {
    const result = scoreJob(scoreInput(analysis(strongReqs), assessment({ r1: "met", r2: "unknown", r3: "met" }), { answers: { r2: "no" } }));
    expect(result.items.find((i) => i.requirementId === "r2")).toMatchObject({ status: "unmet", overridden: true });
  });

  it("lists the requirements that would lift the tier", () => {
    const reqs = [req("m1"), req("m2"), req("m3")];
    const result = scoreJob(scoreInput(analysis(reqs), assessment({ m1: "unmet", m2: "met", m3: "met" })));
    expect(result.whatWouldChange.map((w) => w.requirementId)).toContain("m1");
  });

  it("marks old postings stale and very old ones ineligible", () => {
    const aging = scoreJob(scoreInput(analysis(strongReqs), assessment({ r1: "met", r2: "met", r3: "met" }), { postedAt: new Date("2026-08-20T00:00:00Z") }));
    const dead = scoreJob(scoreInput(analysis(strongReqs), assessment({ r1: "met", r2: "met", r3: "met" }), { postedAt: new Date("2026-07-01T00:00:00Z") }));
    expect(aging.gates).toContainEqual(expect.objectContaining({ kind: "stale", status: "unclear" }));
    expect(dead.eligibility).toBe("ineligible");
  });
});

describe("Interview Chance — properties", () => {
  const status = fc.constantFrom<AssessmentStatus>(...ASSESSMENT_STATUSES);
  const reqs = [req("a"), req("b"), req("c", { kind: "nice" }), req("d"), req("e", { kind: "nice" })];

  it("never lowers the score when a requirement becomes met", () => {
    fc.assert(
      fc.property(fc.tuple(status, status, status, status, status), fc.integer({ min: 0, max: 4 }), (statuses, flip) => {
        const map = Object.fromEntries(reqs.map((r, i) => [r.id, statuses[i]]));
        const before = scoreJob(scoreInput(analysis(reqs), assessment(map)));
        const after = scoreJob(scoreInput(analysis(reqs), assessment({ ...map, [reqs[flip].id]: "met" })));
        expect(after.score).toBeGreaterThanOrEqual(before.score);
        expect(tierRank(after.tier)).toBeGreaterThanOrEqual(tierRank(before.tier));
      }),
      { numRuns: 200 },
    );
  });

  it("always reports Ineligible when any gate fails, and always respects caps", () => {
    fc.assert(
      fc.property(fc.tuple(status, status, status, status, status), fc.boolean(), (statuses, citizenshipRequired) => {
        const map = Object.fromEntries(reqs.map((r, i) => [r.id, statuses[i]]));
        const gate = citizenshipRequired ? [req("g", { kind: "gate", category: "work_rights", gate: "citizenship" })] : [];
        const result = scoreJob(scoreInput(analysis([...gate, ...reqs]), assessment(map)));
        if (result.gates.some((g) => g.status === "fail")) expect(result.eligibility).toBe("ineligible");
        for (const cap of result.capsApplied) expect(tierRank(result.tier)).toBeLessThanOrEqual(tierRank(cap.maxTier));
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(100);
      }),
      { numRuns: 200 },
    );
  });
});
