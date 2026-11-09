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

  it("refuses a changed number even when it is glued to a word (5명, 3개, 2배)", () => {
    expect(polishGate("팀원 5명과 대시보드를 만들었습니다", "팀원 6명과 대시보드를 만들었습니다.")).toMatchObject({ ok: false, reason: "numbers" });
    expect(polishGate("3개 팀을 맡았습니다", "4개 팀을 맡았습니다.")).toMatchObject({ ok: false, reason: "numbers" });
    expect(polishGate("매출을 2배로 늘렸습니다", "매출을 3배로 늘렸습니다.")).toMatchObject({ ok: false, reason: "numbers" });
    expect(polishGate("팀원 5명과 대시보드를 만들었어요", "팀원 5명과 대시보드를 만들었습니다.")).toEqual({ ok: true });
    expect(polishGate("Cut costs 3x in a year", "Cut costs 4x in a year.")).toMatchObject({ ok: false, reason: "numbers" });
  });

  it("refuses new acronyms and names anywhere, and keeps names that opened the answer", () => {
    for (const text of [
      "Led a team of 5 at EY on the merchant dashboard.",
      "Led the AI team of 5 on the merchant dashboard.",
      "Led a team of 5 on the merchant dashboard in R.",
      "Led a team of 5 people as VP on the merchant dashboard.",
      "Led a team of 5 on the merchant dashboard with ML.",
      "Led a team of 5 on the merchant dashboard. Google noticed.",
      "AI team of 5 on the merchant dashboard.",
    ]) {
      expect(polishGate(raw, text), text).toMatchObject({ ok: false, reason: "new_term" });
    }
    expect(polishGate("Google hired me to lead 5 people", "Hired to lead 5 people.")).toMatchObject({ ok: false, reason: "dropped" });
    expect(polishGate("Google hired me to lead 5 people", "Hired by Google to lead 5 people.")).toEqual({ ok: true });
    // A capital that is only grammar is not a name: an opening word or verb may be reworded.
    expect(polishGate("Mostly I built reports in SQL for 3 teams", "Built reports in SQL for 3 teams.")).toEqual({ ok: true });
    expect(polishGate("Managed the reporting team of 5", "Led the reporting team of 5.")).toEqual({ ok: true });
    expect(polishGate("I've led 2 migrations to the cloud", "Led 2 migrations to the cloud.")).toEqual({ ok: true });
  });

  it("a new first word must read as an opening verb, not a name", () => {
    expect(polishGate("we cut costs by 30%", "Google cut costs by 30%.")).toMatchObject({ ok: false, reason: "new_term" });
    expect(polishGate("we cut costs by 30%", "Accenture and we cut costs by 30%.")).toMatchObject({ ok: false, reason: "new_term" });
    expect(polishGate("I was running the night shift for 2 years", "Ran the night shift for 2 years.")).toEqual({ ok: true });
    expect(polishGate("I made the reports for 3 teams", "Built the reports for 3 teams.")).toEqual({ ok: true });
    expect(polishGate("I was in charge of the reporting team, there were 5 people and we built dashboards for sales", "Led the 5-person reporting team that built sales dashboards.")).toEqual({ ok: true });
    expect(polishGate("Managed the reporting team of 5", "Led the reporting team of 5.")).toEqual({ ok: true });
  });

  it("keeps employers and titles from the forms wherever they stand in the answer", () => {
    const keep = ["Boeing", "Booking.com", "Head of Data"];
    expect(polishGate("Boeing hired me to lead 5 engineers", "Hired to lead 5 engineers.", { keep })).toMatchObject({ ok: false, reason: "dropped" });
    expect(polishGate("Booking.com hired me to lead 5 engineers", "Hired to lead 5 engineers.", { keep })).toMatchObject({ ok: false, reason: "dropped" });
    expect(polishGate("Boeing hired me to lead 5 engineers", "Hired by Boeing to lead 5 engineers.", { keep })).toEqual({ ok: true });
    expect(polishGate("I lead 5 engineers", "Lead 5 engineers.", { keep })).toEqual({ ok: true });
  });

  it("refuses Korean size words the revision adds, not ones the candidate used", () => {
    for (const word of ["대규모", "대형", "핵심", "전사", "수많은", "최초", "최고"]) {
      expect(polishGate("팀원 5명과 대시보드를 만들었습니다", `팀원 5명과 ${word} 대시보드를 만들었습니다.`), word).toMatchObject({ ok: false, reason: "new_term" });
    }
    expect(polishGate("팀원 5명과 대규모 대시보드를 만들었어요", "팀원 5명과 대규모 대시보드를 만들었습니다.")).toEqual({ ok: true });
  });

  it("refuses size words in any form and stock words in any form", () => {
    for (const word of ["largest", "biggest", "huge", "massive", "larger"]) {
      expect(polishGate("I led a team on the merchant dashboard", `Led the ${word} team on the merchant dashboard.`), word).toMatchObject({ ok: false, reason: "new_term" });
    }
    expect(polishGate("I grew sign-ups on the merchant dashboard", "Grew sign-ups on the merchant dashboard, doubling them.")).toMatchObject({ ok: false, reason: "new_term" });
    expect(polishGate("I built it in the cloud", "Built it in the cloud, leveraging AWS.")).toMatchObject({ ok: false });
    expect(polishGate("I built it on cloud servers", "Built it, leveraging cloud servers.")).toMatchObject({ ok: false, reason: "style" });
    expect(polishGate("I built the backend services", "Built the backend services in java.")).toMatchObject({ ok: false, reason: "new_term" });
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
