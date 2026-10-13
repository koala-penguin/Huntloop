import { describe, expect, it } from "vitest";
import { buildProvenanceContext, checkLine, extractNumbers, validateLinkedin } from "@/server/cv/provenance";
import type { CvLine, LinkedinDocument } from "@/shared/schemas/cv";
import type { ScoreResult } from "@/shared/schemas/job";
import { CV_TEXT, analysis, profile, req } from "../helpers/scoring";

const HARBOUR = "Led the rebuild of the merchant dashboard in React and TypeScript, cutting page load time by 40%.";
const KOALA = "Built checkout flows in React used by 2 million monthly customers.";

function data() {
  const p = profile();
  p.experience[0].highlights = [HARBOUR, "Mentored 4 engineers."];
  p.experience[1].highlights = [KOALA];
  p.facts = [{ id: "fact-1", text: "I ran WCAG 2.2 accessibility audits for two years.", source: "user" }];
  return p;
}

const reqs = [req("r1", { normalized: "React" }), req("r2", { normalized: "Kubernetes" }), req("r3", { normalized: "GraphQL", kind: "nice" }), req("r4", { normalized: "5+ years frontend", category: "years", minYears: 5 })];
const score = { items: [{ requirementId: "r1", status: "met" }, { requirementId: "r2", status: "unmet" }, { requirementId: "r3", status: "unknown" }, { requirementId: "r4", status: "met" }] } as unknown as ScoreResult;
const now = new Date("2026-10-13");
const pctx = () => buildProvenanceContext({ cvText: CV_TEXT, data: data() }, { analysis: analysis(reqs), score, plan: null }, now);

const line = (text: string, quotes: Array<string | { fact: string; id: string | null }>, origin: CvLine["origin"] = "ai"): CvLine => ({
  id: "l1",
  text,
  origin,
  requirementIds: [],
  sourceRefs: quotes.map((q) => (typeof q === "string" ? { source: "cv", quote: q, factId: null, verified: false } : { source: "fact", quote: q.fact, factId: q.id, verified: false })),
});
const kinds = (l: CvLine, roleId: string | null = "exp-1") => checkLine(l, { roleId }, pctx()).map((f) => `${f.kind}:${f.severity}`);

describe("numbers", () => {
  it("treats the same amount written differently as equal, and percentages apart from plain numbers", () => {
    const values = (s: string) => extractNumbers(s).map((n) => [n.kind, n.value]);
    expect(values("$1.2M")).toEqual(values("1.2 million"));
    expect(values("$1,200,000")).toEqual(values("1.2 million"));
    expect(values("30%")).toEqual([["percent", 30]]);
    expect(values("30")).toEqual([["number", 30]]);
    expect(values("200만 명")).toEqual([["number", 2_000_000]]);
    expect(values("3x faster")).toEqual([["multiple", 3]]);
    expect(extractNumbers("5+ years of React")[0]).toMatchObject({ value: 5, years: true });
    expect(extractNumbers("AWS S3, EC2 and 3D charts")).toEqual([]);
  });
});

describe("line checks", () => {
  it("accepts a reworded line backed by a real quote from the same role", () => {
    expect(kinds(line("Rebuilt the merchant dashboard in React, cutting page load time by 40%.", [HARBOUR]))).toEqual([]);
  });

  it("flags a quote that isn't in the CV, and lines without a real source", () => {
    expect(kinds(line("Led the platform team.", ["Led the platform team of 12"]))).toEqual(["unverified_source:block", "unsourced:block"]);
    expect(kinds(line("Strong React engineer.", ["React"]))).toContain("unsourced:block");
  });

  it("flags quotes taken from another role", () => {
    expect(kinds(line("Built checkout flows used by 2 million customers.", [KOALA]))).toEqual(["other_role:block"]);
    expect(kinds(line("Built checkout flows used by 2 million customers.", [KOALA]), "exp-2")).toEqual([]);
  });

  it("flags numbers that aren't in the line's sources, allowing years of experience up to the real total", () => {
    expect(kinds(line("Cut page load time by 45%.", [HARBOUR]))).toEqual(["number:block"]);
    expect(kinds(line("Cut page load time by 40% across 3 apps.", [HARBOUR]))).toEqual(["number:block"]);
    // 2018-01 → today is 8 whole years.
    expect(kinds(line("8+ years of React, cutting page load time by 40%.", [HARBOUR]), null)).toEqual([]);
    expect(kinds(line("10+ years of React, cutting page load time by 40%.", [HARBOUR]), null)).toEqual(["number:block"]);
  });

  it("checks fact quotes against that fact", () => {
    expect(kinds(line("Ran WCAG 2.2 accessibility audits for two years.", [{ fact: "WCAG 2.2 accessibility audits for two years", id: "fact-1" }]), null)).toEqual([]);
    expect(kinds(line("Ran WCAG 2.2 audits.", [{ fact: "WCAG 2.2 accessibility audits", id: "fact-9" }]), null)).toContain("unverified_source:block");
  });

  it("never lets the CV claim a requirement the candidate doesn't meet, or a posting skill the role doesn't show", () => {
    expect(kinds(line("Led the rebuild of the merchant dashboard on Kubernetes.", [HARBOUR]))).toEqual(["do_not_claim:block"]);
    expect(kinds(line("Led the rebuild of the merchant dashboard with GraphQL.", [HARBOUR]))).toEqual(["do_not_claim:block"]);
    expect(kinds(line("Led the rebuild of the merchant dashboard in React and TypeScript.", [HARBOUR]))).toEqual([]);
  });

  it("only warns about lines the user wrote themselves", () => {
    expect(kinds(line("Ran Kubernetes clusters for 30 teams.", [], "user"))).toEqual(["number:warn", "do_not_claim:warn"]);
  });
});

describe("LinkedIn limits", () => {
  const ok = (id: string, text: string): CvLine => ({ id, text, sourceRefs: [{ source: "cv", quote: HARBOUR, factId: null, verified: false }], requirementIds: [], origin: "profile" });
  const doc = (headline: number, about: number, position: number): LinkedinDocument => ({
    language: "en",
    headline: ok("headline", "x".repeat(headline)),
    about: [ok("about-0", "y".repeat(about))],
    positions: [{ experienceId: "exp-1", title: "Senior Frontend Engineer", company: "Harbour Payments", bullets: [ok("exp-1-b0", "z".repeat(position - 2))] }],
    topSkills: [],
  });
  const over = (d: LinkedinDocument) =>
    validateLinkedin(d, pctx())
      .filter((f) => f.kind === "over_limit")
      .map((f) => f.params.section);

  it("blocks sections over LinkedIn's character limits", () => {
    expect(over(doc(220, 2600, 2000))).toEqual([]);
    expect(over(doc(221, 2601, 2001))).toEqual(["headline", "about", "position"]);
  });
});
