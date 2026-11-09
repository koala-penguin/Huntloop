import { describe, expect, it } from "vitest";
import { BANNED_PHRASES, styleViolations } from "@/shared/cv-style";
import { roleFamily, suggestionsFor, openingFor, type RoleFamily } from "@/shared/role-suggestions";
import { INTERVIEW_TOPICS } from "@/shared/schemas/interview";
import { polishGate } from "@/server/cv/polish";
import { fakePolish } from "@/server/ai/fake/generators/interview";
import { ANSWERS } from "../helpers/interview";

describe("style rules", () => {
  it("finds every banned phrase, an em dash, a long line and an opening I", () => {
    for (const phrase of BANNED_PHRASES) expect(styleViolations(`Something ${phrase} here.`)).toContain(phrase);
    expect(styleViolations("Cut report turnaround from 5 days to 2.")).toEqual([]);
    expect(styleViolations("Built it — fast.")).toContain("em_dash");
    expect(styleViolations("x".repeat(221))).toContain("too_long");
    expect(styleViolations("x".repeat(300), { maxLength: 400 })).toEqual([]);
    expect(styleViolations("I led the team.", { firstPerson: true })).toContain("first_person");
    // Whole words only: "leverage" is not in "leveraging"... but "dynamic" is not in "dynamics" either.
    expect(styleViolations("Group dynamics workshop.")).toEqual([]);
  });
});

describe("the revision check (polishGate)", () => {
  const raw = "I led a team of 5 on the merchant dashboard";
  it("accepts a cleaned-up version in the candidate's words", () => {
    expect(polishGate(raw, "Led a team of 5 on the merchant dashboard.")).toEqual({ ok: true });
    // A normal edit: "in charge of" → "Led", "5 people" → "5-person".
    expect(polishGate("I was in charge of the reporting team, there were 5 people and we built dashboards for sales", "Led the 5-person reporting team that built sales dashboards.")).toEqual({ ok: true });
    // A stock word the candidate typed themselves may stay.
    expect(polishGate("I leveraged our CRM data to cut churn by 10%", "Leveraged our CRM data to cut churn by 10%.")).toEqual({ ok: true });
    expect(polishGate(ANSWERS.korean, `${ANSWERS.korean.replace(/\.$/, "")}.`)).toEqual({ ok: true });
    expect(polishGate("리액트로 결제 화면을 만들었어요", "리액트로 결제 화면을 만들었습니다.")).toEqual({ ok: true });
  });

  it("refuses added or dropped numbers, new names, tools and size claims, stock phrases and drift", () => {
    expect(polishGate(raw, "Led a team of 6 on the merchant dashboard.")).toMatchObject({ ok: false, reason: "numbers" });
    expect(polishGate("I was in charge of the reporting team, there were 5 people and we built dashboards for sales", "Led the reporting team that built sales dashboards.")).toMatchObject({ ok: false, reason: "numbers" });
    expect(polishGate(raw, "Led a team of 5 on the merchant dashboard in Snowflake.")).toMatchObject({ ok: false, reason: "new_term" });
    expect(polishGate("I built the sales dashboards", "Built the sales dashboards using dbt.")).toMatchObject({ ok: false, reason: "new_term" });
    expect(polishGate("I led a team on the merchant dashboard", "Led a large team on the merchant dashboard.")).toMatchObject({ ok: false, reason: "new_term" });
    expect(polishGate("I built dashboards in Tableau for the sales team", "Built dashboards for the sales team.")).toMatchObject({ ok: false, reason: "dropped" });
    expect(polishGate(ANSWERS.korean, "리액트와 Snowflake로 월 200만 명이 쓰는 결제 화면을 만들었습니다.")).toMatchObject({ ok: false, reason: "new_term" });
    expect(polishGate(raw, "Spearheaded a team of 5 on the merchant dashboard.")).toMatchObject({ ok: false, reason: "style" });
    expect(polishGate(raw, "Led a team of 5 — on the merchant dashboard.")).toMatchObject({ ok: false, reason: "style" });
    expect(polishGate(raw, "I led a team of 5 on the merchant dashboard.")).toMatchObject({ ok: false, reason: "style" });
    expect(polishGate(raw, "Directed a group of 5 building the vendor console.")).toMatchObject({ ok: false, reason: "drift" });
    expect(polishGate("I fixed bugs", "Fixed bugs. Fixed bugs again. Fixed more bugs. Fixed bugs.")).toMatchObject({ ok: false });
  });

  it("the demo interviewer's revision passes for every sample answer", () => {
    for (const answer of Object.values(ANSWERS)) expect(polishGate(answer, fakePolish(answer))).toEqual({ ok: true });
    expect(fakePolish("I led a team of 5 on the merchant dashboard")).toBe("Led a team of 5 on the merchant dashboard.");
    expect(fakePolish("I report to the Head of Engineering and 3 engineers report to me")).toBe("Report to the Head of Engineering and 3 engineers report to me.");
  });
});

describe("example prompts by kind of role", () => {
  it("maps job titles to a kind of role", () => {
    expect(roleFamily("Head of Data")).toBe("data_leadership");
    expect(roleFamily("Analytics Manager")).toBe("data_leadership");
    expect(roleFamily("데이터 팀장")).toBe("data_leadership");
    expect(roleFamily("Data Analyst")).toBe("data");
    expect(roleFamily("Mobile engineer")).toBe("engineering");
    expect(roleFamily("Barista")).toBe("generic");
    expect(roleFamily("")).toBe("generic");
  });

  it("has examples for every topic, none with a digit", () => {
    const families: RoleFamily[] = ["data_leadership", "data", "engineering", "product", "design", "sales_marketing", "operations", "finance", "people", "generic"];
    for (const family of families)
      for (const topic of INTERVIEW_TOPICS)
        for (const lang of ["en", "ko"]) {
          const options = suggestionsFor(family, topic, lang);
          expect(options.length).toBeGreaterThanOrEqual(3);
          expect(options.every((o) => !/\d/.test(o) && o.length <= 80)).toBe(true);
        }
  });

  it("opens each chat from the role, with examples for that kind of role", () => {
    const opening = openingFor({ stage: "role_deep", role: { title: "Head of Data", company: "PB" }, depth: "deep", targetTitles: [], language: "en" });
    expect(opening.text).toContain("Head of Data at PB");
    expect(opening.options).toContain("Data governance and quality");
    expect(opening.text).not.toContain("—");
    const current = openingFor({ stage: "current", role: { title: "Head of Data", company: "PB" }, depth: null, targetTitles: [], language: "ko" });
    expect(current.topic).toBe("context");
    expect(current.text).toContain("PB의 Head of Data");
  });
});
