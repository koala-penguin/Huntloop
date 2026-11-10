import { describe, expect, it } from "vitest";
import { dateMentions, enumGrounded, hasPresentWord } from "@/shared/interview-dates";
import { groundDate, groundProposal, groundText } from "@/server/cv/form-ground";
import { completeDataStage, createInterview, getInterview, mergeStagePatch, reopenStage, saveStageForm, setStageStatus, type Interview } from "@/server/repo/interviews";
import { interviewReady } from "@/server/cv/interview-build";
import { FORM_CARD_SCHEMAS, cardValueOf, interviewFormSchema, rowIssues, stageFormIssues, stageRequirements, type FormCardValue } from "@/shared/schemas/interview";
import { nextContactQuestion, validEmail } from "@/shared/contact-guide";
import { testDb } from "../helpers/db";

const dates = (text: string) => dateMentions(text).map((d) => d.value);
const typed = (...texts: string[]) => texts.map((text, i) => ({ id: i + 1, text }));

/** An interview with a target and the current role (exp-1) on file. */
function started(setup: { depth?: "full" | "quick" } = {}) {
  const { db, userId } = testDb();
  let interview = createInterview(db, userId, { country: "AU", language: "en", ...setup });
  interview = saveStageForm(db, interview, "target", { titles: ["Senior Frontend Engineer"] });
  interview = saveStageForm(db, interview, "current", { status: "employed", title: "Senior Frontend Engineer", company: "Harbour Payments", start: "2021-03" });
  return { db, userId, ctx: { db, userId }, interview };
}
const reload = (db: ReturnType<typeof testDb>["db"], userId: number, interview: Interview) => getInterview(db, userId, interview.id)!;

describe("dates the candidate typed", () => {
  it("reads a month and year in the ways people write them", () => {
    for (const text of ["Mar 2021", "Mar. 2021", "March, 2021", "march 2021", "2021 March", "2021.03", "2021.3", "2021. 3.", "2021/03", "2021-3", "03/2021", "3/2021", "03.2021", "03-2021", "2021년 3월", "2021년 03월", "2021년3월부터"]) {
      expect(dates(text), text).toEqual(["2021-03"]);
    }
    expect(dates("Sept 2019 to December 2020")).toEqual(["2019-09", "2020-12"]);
    expect(dates("２０２１년 ３월")).toEqual(["2021-03"]);
  });

  it("keeps a year alone when no month was typed, or when the month can't be known", () => {
    expect(dates("since 2021")).toEqual(["2021"]);
    expect(dates("2021년부터")).toEqual(["2021"]);
    expect(dates("3/4/2021")).toEqual(["2021"]);
    expect(dates("04.03.2021")).toEqual(["2021"]);
    expect(dates("the 2020-21 season")).toEqual(["2020"]);
    expect(dates("2021.03.15")).toEqual(["2021-03"]);
    expect(dates("2021-03-15")).toEqual(["2021-03"]);
    expect(dates("In 2021. 3 people joined")).toEqual(["2021"]);
  });

  it("reads both ends of a range, each once", () => {
    expect(dates("2018-01 to 2021-02")).toEqual(["2018-01", "2021-02"]);
    expect(dates("2018-2021")).toEqual(["2018", "2021"]);
    expect(dates("2018–2021")).toEqual(["2018", "2021"]);
    expect(dates("2018~2021")).toEqual(["2018", "2021"]);
    expect(dates("2018.03~2021.02")).toEqual(["2018-03", "2021-02"]);
  });

  it("ignores two-digit years, relative dates and other numbers", () => {
    for (const text of ["21년 3월", "작년", "two years ago", "120000", "a team of 12", "last June"]) expect(dates(text), text).toEqual([]);
  });

  it("knows the words for still being there", () => {
    for (const text of ["2021 to now", "I still work there", "2021.03부터 현재까지", "재직 중입니다", "Present"]) expect(hasPresentWord(text), text).toBe(true);
    for (const text of ["재직했습니다", "I presented the results", "2018 to 2021", "nowhere"]) expect(hasPresentWord(text), text).toBe(false);
  });

  it("knows the words for a level or a status", () => {
    expect(enumGrounded("languageLevel", "native", ["Korean, native"])).toBe(true);
    expect(enumGrounded("languageLevel", "native", ["한국어 원어민"])).toBe(true);
    expect(enumGrounded("languageLevel", "fluent", ["Korean"])).toBe(false);
    expect(enumGrounded("currentStatus", "studying", ["I'm studying"])).toBe(true);
    expect(enumGrounded("seniority", "senior", ["Frontend Engineer"])).toBe(false);
  });
});

describe("grounding a field in the candidate's messages", () => {
  it("returns the candidate's own spelling, never the model's", () => {
    expect(groundText("Harbour Payments", typed("i work at harbour payments now"))).toEqual({ value: "harbour payments", messageId: 1 });
    expect(groundText("Harbour  Payments", typed("first", "At Harbour\nPayments since 2021"))).toEqual({ value: "Harbour\nPayments", messageId: 2 });
    expect(groundText("O'Brien & Sons", typed("I was at O’Brien & Sons"))?.value).toBe("O’Brien & Sons");
  });

  it("rejects an invented value, a join of two messages, an ellipsis and a single character", () => {
    expect(groundText("Acme Corp", typed("I work at Harbour Payments"))).toBeNull();
    expect(groundText("Harbour Payments", typed("Harbour", "Payments"))).toBeNull();
    expect(groundText("Harbour ... Payments", typed("Harbour ... Payments"))).toBeNull();
    expect(groundText("Harbour…", typed("Harbour…"))).toBeNull();
    expect(groundText("H", typed("H"))).toBeNull();
  });

  it("a short ASCII value must stand alone, but Korean particles never block a match", () => {
    expect(groundText("PB", typed("I ran the PBX migration"))).toBeNull();
    expect(groundText("PB", typed("I work at PB, a retailer"))?.value).toBe("PB");
    expect(groundText("PB", typed("PB에서 일했어요"))?.value).toBe("PB");
    const message = typed("카카오에서 데이터 분석가로 일했습니다");
    expect(groundText("카카오", message)?.value).toBe("카카오");
    expect(groundText("데이터 분석가", message)?.value).toBe("데이터 분석가");
  });

  it("matches decomposed Hangul and keeps offsets right after a character that changes length in lower case", () => {
    const nfd = "카카오에서 일했습니다".normalize("NFD");
    expect(groundText("카카오", typed(nfd))?.value).toBe("카카오");
    const message = typed("İstanbul Teknik, then Data Analyst at Koala Commerce");
    expect(groundText("istanbul teknik", typed("istanbul teknik"))?.value).toBe("istanbul teknik");
    expect(groundText("İstanbul Teknik", message)?.value).toBe("İstanbul Teknik");
    expect(groundText("data analyst", message)?.value).toBe("Data Analyst");
    expect(groundText("Koala Commerce", message)?.value).toBe("Koala Commerce");
  });

  it("keeps a month only when the candidate typed it", () => {
    expect(groundDate("2021-03", typed("since March 2021"))).toEqual({ value: "2021-03", messageId: 1 });
    expect(groundDate("2021-03", typed("since 2021"))).toEqual({ value: "2021", messageId: 1 });
    expect(groundDate("2021-03", typed("since May 2021"))?.value).toBe("2021");
    expect(groundDate("2021", typed("since March 2021"))?.value).toBe("2021");
    expect(groundDate("2019-03", typed("since March 2021"))).toBeNull();
    expect(groundDate("March 2021", typed("since March 2021"))).toBeNull();
  });
});

const role = (patch: Record<string, unknown>) => ({ id: "", title: "", company: "", industry: "", location: "", start: "", end: "", current: false, employment_type: "full_time", ...patch });

describe("grounding a proposal", () => {
  it("drops an invented employer and says so; nothing on the card is the model's", () => {
    const { interview } = started();
    const result = groundProposal("roles", { roles: [role({ title: "Frontend Engineer", company: "Acme Corp", start: "2018-01", end: "2021-02" })] }, typed("I was a frontend engineer from 2018-01 to 2021-02"), interview.form, { toolUseId: "toolu_1" });
    if (result.empty) throw new Error("expected a card");
    const [row] = (result.value as FormCardValue<"roles">).roles;
    expect(row).toMatchObject({ id: "new-toolu_1_0", title: "frontend engineer", company: "", start: "2018-01", end: "2021-02", current: false, depth: "deep" });
    expect(result.dropped).toEqual(["roles.0.company"]);
    expect(result.sources).toMatchObject({ "roles.0.title": 1, "roles.0.start": 1 });
    expect(FORM_CARD_SCHEMAS.roles.safeParse(result.value).success).toBe(true);
  });

  it("gives the year alone when the month was not typed", () => {
    const { interview } = started();
    const result = groundProposal("roles", { roles: [role({ title: "Frontend Engineer", company: "Koala Commerce", start: "2018-01", end: "2021-06" })] }, typed("Frontend Engineer at Koala Commerce, 2018 to 2021"), interview.form);
    if (result.empty) throw new Error("expected a card");
    expect((result.value as FormCardValue<"roles">).roles[0]).toMatchObject({ start: "2018", end: "2021" });
  });

  it("marks a role current only when a message about it says so", () => {
    const { interview } = started();
    const proposed = { roles: [role({ title: "Data Analyst", company: "Koala Commerce", start: "2021-03", current: true })] };
    const without = groundProposal("roles", proposed, typed("Data Analyst at Koala Commerce from March 2021"), interview.form);
    if (without.empty) throw new Error("expected a card");
    expect((without.value as FormCardValue<"roles">).roles[0]).toMatchObject({ current: false, end: "" });
    expect(without.unresolved).toEqual(["roles.0.current"]);
    expect(rowIssues("roles", without.value)).toEqual(["roles.0.end"]);

    const said = groundProposal("roles", proposed, typed("Data Analyst at Koala Commerce from March 2021, still there"), interview.form);
    if (said.empty) throw new Error("expected a card");
    expect((said.value as FormCardValue<"roles">).roles[0]).toMatchObject({ current: true, end: "" });
    expect(said.unresolved).toEqual([]);

    // The usual two-message flow: the dates (and "until now") come in a follow-up that names neither title nor employer.
    const followUp = groundProposal("roles", proposed, typed("Data Analyst at Koala Commerce", "2021.03부터 현재까지"), interview.form);
    if (followUp.empty) throw new Error("expected a card");
    expect((followUp.value as FormCardValue<"roles">).roles[0]).toMatchObject({ start: "2021-03", current: true });

    // A present word in a message about something else does not count.
    const elsewhere = groundProposal("roles", proposed, typed("Data Analyst at Koala Commerce from March 2021", "I am currently looking for work"), interview.form);
    if (elsewhere.empty) throw new Error("expected a card");
    expect((elsewhere.value as FormCardValue<"roles">).roles[0].current).toBe(false);
  });

  it("handles a Korean role end to end", () => {
    const { interview } = started();
    const proposed = { roles: [role({ title: "데이터 분석가", company: "카카오", start: "2021-03", current: true })] };
    const result = groundProposal("roles", proposed, typed("카카오에서 데이터 분석가로 2021년 3월부터 현재까지 일하고 있습니다"), interview.form);
    if (result.empty) throw new Error("expected a card");
    expect((result.value as FormCardValue<"roles">).roles[0]).toMatchObject({ company: "카카오", title: "데이터 분석가", start: "2021-03", current: true });
    const past = groundProposal("roles", proposed, typed("카카오에서 데이터 분석가로 2021년 3월부터 일했습니다"), interview.form);
    if (past.empty) throw new Error("expected a card");
    expect(past.unresolved).toEqual(["roles.0.current"]);
    expect(rowIssues("roles", past.value)).toContain("roles.0.end");
  });

  it("keeps what only the candidate can pick from the saved row, and treats an unknown id as a new role", () => {
    const { db, interview: first } = started();
    const interview = saveStageForm(db, first, "roles", [{ ...first.form.roles[0], country: "AU", seniority: "senior", depth: "brief" }]);
    const update = groundProposal("roles", { roles: [role({ id: "exp-1", title: "Senior Frontend Engineer", company: "Harbour Payments", location: "Sydney" })] }, typed("Senior Frontend Engineer at Harbour Payments, in Sydney"), interview.form);
    if (update.empty) throw new Error("expected a card");
    expect((update.value as FormCardValue<"roles">).roles[0]).toMatchObject({ id: "exp-1", country: "AU", seniority: "senior", depth: "brief", location: "Sydney", start: "2021-03", current: true });

    const unknown = groundProposal("roles", { roles: [role({ id: "exp-9", title: "Barista", company: "Bean There" })] }, typed("Barista at Bean There"), interview.form, { toolUseId: "t" });
    if (unknown.empty) throw new Error("expected a card");
    expect((unknown.value as FormCardValue<"roles">).roles[0]).toMatchObject({ id: "new-t_0", country: "", seniority: null });

    // The model repeats a saved role without its id: the saved row is updated, not duplicated.
    const repeated = groundProposal("roles", { roles: [role({ title: "senior frontend engineer", company: "harbour payments", location: "Sydney" })] }, typed("Senior Frontend Engineer at Harbour Payments, in Sydney"), interview.form);
    if (repeated.empty) throw new Error("expected a card");
    expect((repeated.value as FormCardValue<"roles">).roles.map((r) => r.id)).toEqual(["exp-1"]);
  });

  it("a quick interview covers older roles briefly", () => {
    const { interview } = started({ depth: "quick" });
    const result = groundProposal("roles", { roles: [role({ title: "Barista", company: "Bean There" })] }, typed("Barista at Bean There"), interview.form);
    if (result.empty) throw new Error("expected a card");
    expect((result.value as FormCardValue<"roles">).roles[0].depth).toBe("brief");
  });

  it("starts from the card still waiting, so a role typed but not yet accepted is kept", () => {
    const { interview } = started();
    const first = groundProposal("roles", { roles: [role({ title: "Barista", company: "Bean There", start: "2015", end: "2016" })] }, typed("Barista at Bean There 2015-2016"), interview.form, { toolUseId: "a" });
    if (first.empty) throw new Error("expected a card");
    const second = groundProposal("roles", { roles: [role({ title: "Waiter", company: "Cafe Uno", start: "2014", end: "2015" })] }, typed("Barista at Bean There 2015-2016", "Waiter at Cafe Uno 2014-2015"), interview.form, { toolUseId: "b", pending: first });
    if (second.empty) throw new Error("expected a card");
    expect((second.value as FormCardValue<"roles">).roles.map((r) => [r.id, r.title])).toEqual([["new-a_0", "Barista"], ["new-b_0", "Waiter"]]);
    expect(second.sources).toMatchObject({ "roles.0.title": 1, "roles.1.title": 2 });
  });

  it("is empty when nothing proposed is in the messages", () => {
    const { interview } = started();
    expect(groundProposal("roles", { roles: [role({ title: "Wizard", company: "Hogwarts", start: "1997" })] }, typed("I'd rather not say"), interview.form)).toEqual({ empty: true, dropped: ["roles.0.title"] });
    expect(groundProposal("languages", { languages: [{ language: "Klingon", level: "native" }] }, typed("English"), interview.form)).toEqual({ empty: true, dropped: ["languages.0.language"] });
  });

  it("adds grounded target items to what is on file and never invents a level of seniority", () => {
    const { interview } = started();
    const result = groundProposal("target", { titles: ["Staff Engineer", "Chief Wizard"], cities: ["Melbourne"], seniority: ["director"], workplace: ["remote"] }, typed("Staff Engineer, in Melbourne or remote"), interview.form);
    if (result.empty) throw new Error("expected a card");
    const value = result.value as FormCardValue<"target">;
    expect(value.titles).toEqual(["Senior Frontend Engineer", "Staff Engineer"]);
    expect(value.cities).toEqual(["Melbourne"]);
    expect(value.seniority).toEqual([]);
    expect(value.workplace).toEqual(["remote"]);
    expect(result.inferred).toEqual(["workplace"]);
    expect(result.dropped).toEqual(["titles"]);
  });

  it("leaves a language level open unless its word was typed", () => {
    const { interview } = started();
    const open = groundProposal("languages", { languages: [{ language: "Korean", level: "native" }] }, typed("Korean"), interview.form);
    if (open.empty) throw new Error("expected a card");
    expect(open.value).toEqual({ languages: [{ language: "Korean", level: "" }] });
    expect(open.unresolved).toEqual(["languages.0.level"]);
    expect(rowIssues("languages", open.value)).toEqual(["languages.0.level"]);
    const said = groundProposal("languages", { languages: [{ language: "Korean", level: "native" }] }, typed("Korean, native"), interview.form);
    if (said.empty) throw new Error("expected a card");
    expect(said.value).toEqual({ languages: [{ language: "Korean", level: "native" }] });
    expect(said.inferred).toEqual(["languages.0.level"]);
    expect(said.unresolved).toEqual([]);
  });

  it("makes a card from a status alone, and from education and certifications", () => {
    const { db, userId } = testDb();
    const interview = createInterview(db, userId, {});
    const studying = groundProposal("current", { status: "studying", title: "", company: "", start: "" }, typed("I'm studying"), interview.form);
    if (studying.empty) throw new Error("expected a card");
    expect(studying.value).toMatchObject({ status: "studying", title: "" });
    expect(studying.inferred).toEqual(["status"]);
    expect(groundProposal("current", { status: "studying", title: "", company: "", start: "" }, typed("hello there"), interview.form).empty).toBe(true);

    const education = groundProposal(
      "education",
      { education: [{ institution: "Example University", degree: "BSc", field: "Physics", start: "2012", end: "2015" }], certifications: [{ name: "AWS Solutions Architect", issuer: "Amazon", year: "2020" }] },
      typed("BSc in Physics at Example University, 2012 to 2015", "cert: AWS Solutions Architect, 2020"),
      interview.form,
      { toolUseId: "e" },
    );
    if (education.empty) throw new Error("expected a card");
    expect(education.value).toEqual({
      education: [{ id: "edu-e_0", institution: "Example University", degree: "BSc", field: "Physics", country: null, start: "2012", end: "2015" }],
      certifications: [{ name: "AWS Solutions Architect", issuer: null, year: "2020" }],
    });
    expect(education.dropped).toEqual(["certifications.0.issuer"]);
  });
});

describe("what a step needs before Continue", () => {
  it("lists what is missing, in code", () => {
    const empty = interviewFormSchema.parse({});
    expect(stageRequirements("target", empty)).toEqual(["target.title"]);
    expect(stageRequirements("current", empty)).toEqual(["current.title"]);
    expect(stageRequirements("current", interviewFormSchema.parse({ current: { status: "studying" } }))).toEqual([]);
    expect(stageRequirements("roles", empty)).toEqual(["roles.none"]);
    expect(stageRequirements("education", empty)).toEqual([]);
    expect(stageRequirements("languages", empty)).toEqual([]);
    expect(stageRequirements("contact", empty)).toEqual(["contact.name", "contact.email"]);
    expect(stageRequirements("contact", interviewFormSchema.parse({ contact: { name: "Morgan Ellis", email: "morgan@" } }))).toEqual(["contact.email"]);
    expect(stageRequirements("contact", interviewFormSchema.parse({ contact: { name: "Morgan Ellis", email: "morgan@example.com" } }))).toEqual([]);
    const roles = interviewFormSchema.parse({
      roles: [
        { id: "exp-1", title: "Engineer", company: "A", start: "2021-03" },
        { id: "exp-2", title: "", company: "B", start: "", end: "2020" },
        { id: "exp-3", title: "Barista", company: "C", start: "2019-05", end: "2019-02" },
        { id: "exp-4", title: "Waiter", company: "D", start: "2018", end: "2018-06" },
      ],
    });
    expect(stageRequirements("roles", roles)).toEqual(["roles.1.title", "roles.1.start", "roles.2.order"]);
  });

  it("checks the rows of a card, and the format of what is saved", () => {
    expect(rowIssues("roles", { roles: [{ title: "Engineer", start: "2021", end: "", current: false }] })).toEqual(["roles.0.end"]);
    expect(rowIssues("roles", { roles: [{ title: "Engineer", start: "2021", end: "", current: true }] })).toEqual([]);
    expect(rowIssues("roles", { roles: [{ title: "Engineer", start: "2021-13", end: "2020", current: false }] })).toEqual(["roles.0.start"]);
    expect(stageFormIssues("contact", { email: "morgan@", phone: "12" })).toEqual(["contact.email", "contact.phone"]);
    expect(stageFormIssues("contact", { email: "", phone: "" })).toEqual([]);
    expect(stageFormIssues("contact", { email: "morgan@example.com", phone: "+61 400 111 222" })).toEqual([]);
    expect(stageFormIssues("roles", { roles: [{ title: "x", start: "2021", end: "2019" }] })).toEqual(["roles.0.order"]);
    expect(FORM_CARD_SCHEMAS.current.safeParse({ status: "employed", title: "Engineer", start: "2021-13" }).success).toBe(false);
  });

  it("merges a card into what is saved, or replaces the section from the On file editor", () => {
    const { db, interview } = started();
    const card = { roles: [{ ...cardValueOf(interview.form, "roles").roles[0], location: "Sydney" }, FORM_CARD_SCHEMAS.roles.parse({ roles: [{ id: "new-a_0", title: "Barista", company: "Bean There", start: "2015", end: "2016" }] }).roles[0]] } as FormCardValue<"roles">;
    const saved = saveStageForm(db, interview, "roles", mergeStagePatch(interview, "roles", card));
    expect(saved.form.roles.map((r) => [r.id, r.title, r.location, r.end])).toEqual([
      ["exp-1", "Senior Frontend Engineer", "Sydney", ""],
      ["exp-2", "Barista", "", "2016"],
    ]);
    // A card with one row adds to the others; the editor's value is the whole section.
    const one = { roles: [{ ...cardValueOf(saved.form, "roles").roles[1], end: "2017" }] } as FormCardValue<"roles">;
    expect((mergeStagePatch(saved, "roles", one) as unknown[]).length).toBe(2);
    const replaced = saveStageForm(db, saved, "roles", mergeStagePatch(saved, "roles", one, { replace: true }));
    expect(replaced.form.roles.map((r) => [r.id, r.end])).toEqual([["exp-2", "2017"]]);

    const languages = saveStageForm(db, replaced, "languages", mergeStagePatch(replaced, "languages", { languages: [{ language: "English", level: "native" }] }));
    const more = saveStageForm(db, languages, "languages", mergeStagePatch(languages, "languages", { languages: [{ language: "english", level: "fluent" }, { language: "Korean", level: "native" }, { language: "", level: "basic" }] }));
    expect(more.form.languages).toEqual([{ language: "english", level: "fluent" }, { language: "Korean", level: "native" }]);
    const target = mergeStagePatch(more, "target", { ...more.form.target, titles: ["Staff Engineer"] }) as { titles: string[] };
    expect(target.titles).toEqual(["Staff Engineer"]);
  });

  it("finishes a data step: skipped and still empty stays skipped, skipped then filled is done", () => {
    const { db, userId, interview } = started();
    let current = setStageStatus(db, interview, "education", "skipped", "languages");
    current = completeDataStage(db, current, "education");
    expect(current.stages.education).toBe("skipped");
    expect(current.stage).toBe("languages");
    current = saveStageForm(db, current, "education", { education: [{ id: "edu-1", institution: "Example University", degree: null, field: null, country: null, start: null, end: null }], certifications: [] });
    current = completeDataStage(db, current, "education");
    expect(reload(db, userId, current).stages.education).toBe("done");
    current = reopenStage(db, current, "education");
    expect(reload(db, userId, current)).toMatchObject({ stage: "education", stages: { education: "pending" } });
    expect(completeDataStage(db, current, "education").stages.education).toBe("done");
  });
});

describe("ready to generate", () => {
  const ready = (patch: Record<string, unknown> = {}) => ({
    form: interviewFormSchema.parse({
      target: { titles: ["Senior Frontend Engineer"] },
      roles: [{ id: "exp-1", title: "Senior Frontend Engineer", company: "Harbour Payments", start: "2021-03" }],
      contact: { name: "Morgan Ellis", email: "morgan@example.com" },
      ...patch,
    }),
    stages: { "role:exp-1": "done" as const },
  });

  it("needs an email while the interview is in progress, but not to generate a finished one again", () => {
    expect(interviewReady(ready())).toEqual({ ok: true });
    const noEmail = ready({ contact: { name: "Morgan Ellis" } });
    expect(interviewReady(noEmail)).toEqual({ ok: false, missing: ["contact"] });
    expect(interviewReady(noEmail, { regenerate: true })).toEqual({ ok: true });
  });

  it("needs every role to have a title and dates, as Continue does", () => {
    const noStart = ready({ roles: [{ id: "exp-1", title: "Senior Frontend Engineer", company: "Harbour Payments" }] });
    expect(interviewReady(noStart)).toEqual({ ok: false, missing: ["roles"] });
    expect(interviewReady(noStart, { regenerate: true })).toEqual({ ok: true });
  });
});

describe("the contact step's questions", () => {
  const contact = (patch: Record<string, unknown> = {}) => interviewFormSchema.parse({ contact: patch }).contact;

  it("asks for the name and email first, then what is optional, and stops when all is given or skipped", () => {
    expect(nextContactQuestion(contact())).toBe("name");
    expect(nextContactQuestion(contact({ name: "Morgan Ellis" }))).toBe("email");
    // Required questions can't be skipped, and a malformed email is asked for again.
    expect(nextContactQuestion(contact(), ["name", "email"])).toBe("name");
    expect(nextContactQuestion(contact({ name: "Morgan Ellis", email: "morgan@" }))).toBe("email");
    const basics = { name: "Morgan Ellis", email: "morgan@example.com" };
    expect(nextContactQuestion(contact(basics))).toBe("phone");
    expect(nextContactQuestion(contact(basics), ["phone"])).toBe("city");
    expect(nextContactQuestion(contact({ ...basics, phone: "0400 111 222", city: "Sydney" }))).toBe("links");
    expect(nextContactQuestion(contact({ ...basics, phone: "0400 111 222", city: "Sydney" }), ["links"])).toBeNull();
    expect(nextContactQuestion(contact({ ...basics, phone: "0400 111 222", city: "Sydney", links: ["https://example.com/morgan"] }))).toBeNull();
  });

  it("tells an email address from something else", () => {
    for (const ok of ["morgan@example.com", " a.b+c@sub.example.co.nz "]) expect(validEmail(ok), ok).toBe(true);
    for (const bad of ["", "morgan", "morgan@", "@example.com", "morgan@example", "mor gan@example.com"]) expect(validEmail(bad), bad).toBe(false);
  });
});
