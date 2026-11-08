import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { experienceYears } from "@/shared/experience";
import { allWorkRightOptionIds, marketPack } from "@/shared/markets";
import { emptyProfile } from "@/shared/schemas/profile";
import { detectDocumentKind, extractDocumentText } from "@/server/cv/extract-text";
import { fakeProfileExtraction } from "@/server/ai/fake/generators/extract-profile";
import { matchWorkRightOption, mergeWithPrevious, profileExtractionSchema, toProfileData } from "@/server/ai/tasks/extract-profile";
import { getCurrentProfile, getPreferences, savePreferences, saveProfileVersion } from "@/server/repo/profile";
import { saveUpload } from "@/server/storage";
import { enqueueTask, getTask, TaskRunner } from "@/server/tasks/runner";
import { EXTRACT_PROFILE_TASK } from "@/server/tasks/handlers/extract-profile";
import { defaultPreferences } from "@/shared/schemas/preferences";
import en from "../../messages/en.json";
import ko from "../../messages/ko.json";
import { testDb } from "../helpers/db";

const fixture = (name: string) => path.join(__dirname, "../fixtures/cv", name);

describe("experienceYears", () => {
  const now = new Date(2026, 9, 12);
  it("adds separate roles and counts the end month", () => {
    expect(experienceYears([{ start: "2020-01", end: "2020-12" }, { start: "2022-01", end: "2022-12" }], now)).toBe(2);
  });
  it("counts overlapping roles once", () => {
    expect(experienceYears([{ start: "2020-01", end: "2021-12" }, { start: "2021-01", end: "2022-12" }], now)).toBe(3);
  });
  it("treats a missing end as current and year-only dates as whole years", () => {
    expect(experienceYears([{ start: "2026-01", end: null }], now)).toBe(0.8);
    expect(experienceYears([{ start: "2019", end: "2019" }], now)).toBe(1);
  });
  it("ignores roles without a parseable start", () => {
    expect(experienceYears([{ start: null, end: "2020-01" }, { start: "soon", end: null }], now)).toBe(0);
  });
});

describe("CV text extraction", () => {
  it("detects PDF, DOCX and text by content", () => {
    expect(detectDocumentKind(new Uint8Array(fs.readFileSync(fixture("sample-cv-en.pdf"))))).toBe("pdf");
    expect(detectDocumentKind(new Uint8Array(fs.readFileSync(fixture("sample-cv-en.docx"))))).toBe("docx");
    expect(detectDocumentKind(new Uint8Array(fs.readFileSync(fixture("sample-cv-ko.txt"))))).toBe("text");
    expect(detectDocumentKind(new Uint8Array([0, 1, 2, 3, 0]))).toBeNull();
  });

  it.each(["sample-cv-en.pdf", "sample-cv-en.docx", "sample-cv-en.txt"])("extracts the text of %s", async (name) => {
    const bytes = new Uint8Array(fs.readFileSync(fixture(name)));
    const text = await extractDocumentText(detectDocumentKind(bytes)!, bytes);
    expect(text).toContain("Harbour Payments");
    expect(text).toContain("Mentored 4 engineers");
  });
});

describe("profile extraction (demo parser + post-processing)", () => {
  it("turns an English CV into dated roles, skills and work rights", () => {
    const raw = profileExtractionSchema.parse(fakeProfileExtraction(fs.readFileSync(fixture("sample-cv-en.txt"), "utf8")));
    const data = toProfileData(raw);
    expect(data.basics.name).toBe("Jamie Park");
    expect(data.experience.map((e) => [e.id, e.company, e.start, e.end])).toEqual([
      ["exp-1", "Harbour Payments", "2021-03", null],
      ["exp-2", "Koala Commerce", "2018-01", "2021-02"],
      ["exp-3", "Seoul Digital Agency", "2016-07", "2017-12"],
    ]);
    expect(data.skills.map((s) => s.name)).toEqual(expect.arrayContaining(["React", "TypeScript", "GraphQL"]));
    expect(data.workRights).toEqual([expect.objectContaining({ country: "AU", status: "permanent_resident", option: "au_pr" })]);
  });

  it("reads Korean CVs with Korean date formats", () => {
    const data = toProfileData(profileExtractionSchema.parse(fakeProfileExtraction(fs.readFileSync(fixture("sample-cv-ko.txt"), "utf8"))));
    expect(data.experience.map((e) => [e.start, e.end])).toEqual([
      ["2020-04", null],
      ["2017-03", "2020-03"],
    ]);
    expect(data.languages).toEqual(expect.arrayContaining([{ language: "Korean", level: "native" }]));
  });

  it("maps visas to market options", () => {
    expect(matchWorkRightOption("AU", "unrestricted_visa", "Temporary Graduate visa subclass 485")).toBe("au_485");
    expect(matchWorkRightOption("US", "needs_sponsorship", "H-1B")).toBe("us_h1b");
    expect(matchWorkRightOption("AU", "citizen", null)).toBe("au_citizen");
    expect(matchWorkRightOption("DE", "needs_sponsorship", null)).toBe("employer_tied_visa");
  });

  it("keeps the user's own work rights and facts when a new CV is uploaded", () => {
    const previous = emptyProfile();
    previous.workRights = [{ country: "AU", status: "citizen", option: "au_citizen", expires: null, note: null }];
    previous.facts = [{ id: "f1", text: "Used Kafka in production", source: "user" }, { id: "f2", text: "old", source: "cv" }];
    const next = emptyProfile();
    next.workRights = [
      { country: "AU", status: "permanent_resident", option: "au_pr", expires: null, note: "PR" },
      { country: "NZ", status: "unrestricted_visa", option: "nz_au_citizen", expires: null, note: null },
    ];
    const merged = mergeWithPrevious(next, previous);
    expect(merged.workRights.find((w) => w.country === "AU")?.status).toBe("citizen");
    expect(merged.workRights.find((w) => w.country === "NZ")).toBeDefined();
    expect(merged.facts.map((f) => f.id)).toEqual(["f1"]);
  });
});

describe("profile repository", () => {
  it("appends versions and keeps the CV file unless replaced", () => {
    const { db, userId } = testDb();
    expect(getCurrentProfile(db, userId)).toBeNull();
    const v1 = saveProfileVersion(db, userId, { cvText: "a", data: emptyProfile(), cvFileName: "cv.pdf", cvFilePath: "/x/cv.pdf" });
    const v2 = saveProfileVersion(db, userId, { cvText: "b", data: emptyProfile() });
    expect([v1.version, v2.version]).toEqual([1, 2]);
    expect(getCurrentProfile(db, userId)).toMatchObject({ version: 2, cvText: "b", cvFileName: "cv.pdf" });
  });

  it("defaults preferences to Australia and saves changes", () => {
    const { db, userId } = testDb();
    expect(getPreferences(db, userId).markets).toEqual([{ country: "AU", primary: true, cities: [], remoteOk: true }]);
    savePreferences(db, userId, { ...defaultPreferences(), targetTitles: ["Frontend Engineer"], maxPostingAgeDays: 14 });
    expect(getPreferences(db, userId)).toMatchObject({ targetTitles: ["Frontend Engineer"], maxPostingAgeDays: 14 });
  });
});

describe("extract-profile background task", () => {
  const original = process.env.HUNTLOOP_DATA_DIR;
  beforeAll(() => {
    process.env.HUNTLOOP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "huntloop-test-"));
  });
  afterAll(() => {
    process.env.HUNTLOOP_DATA_DIR = original;
  });

  it("reads an uploaded DOCX into profile version 1, then a pasted CV into version 2", async () => {
    const { db, userId } = testDb();
    const filePath = await saveUpload("cv", "cv.docx", new Uint8Array(fs.readFileSync(fixture("sample-cv-en.docx"))));
    const first = enqueueTask(db, userId, EXTRACT_PROFILE_TASK, { filePath, fileName: "cv.docx", text: null });
    const runner = new TaskRunner(db);
    await Promise.all(await runner.tick());
    expect(getTask(db, first.id)).toMatchObject({ status: "succeeded", result: { version: 1 } });
    const v1 = getCurrentProfile(db, userId)!;
    expect(v1.cvFileName).toBe("cv.docx");
    expect(v1.cvText).toContain("Harbour Payments");
    expect(v1.data.experience).toHaveLength(3);

    saveProfileVersion(db, userId, { cvText: v1.cvText, data: { ...v1.data, facts: [{ id: "x", text: "Led on-call rotation", source: "user" }] } });
    const second = enqueueTask(db, userId, EXTRACT_PROFILE_TASK, { filePath: null, fileName: null, text: fs.readFileSync(fixture("sample-cv-ko.txt"), "utf8") });
    await Promise.all(await runner.tick());
    expect(getTask(db, second.id)?.status).toBe("succeeded");
    const v3 = getCurrentProfile(db, userId)!;
    expect(v3.version).toBe(3);
    expect(v3.data.facts.map((f) => f.text)).toEqual(["Led on-call rotation"]);
    expect(v3.data.workRights.find((w) => w.country === "AU")?.status).toBe("permanent_resident");
  });

  it("fails with a translatable code for unreadable input", async () => {
    const { db, userId } = testDb();
    const task = enqueueTask(db, userId, EXTRACT_PROFILE_TASK, { filePath: null, fileName: null, text: "too short" });
    await Promise.all(await new TaskRunner(db).tick());
    expect(getTask(db, task.id)?.error).toMatch(/^\[cv_too_short\]/);
  });
});

describe("market packs", () => {
  it("offers the Australian visa options and clearance levels", () => {
    const au = marketPack("AU");
    expect(au.workRightOptions.map((o) => o.visa).filter(Boolean)).toEqual(expect.arrayContaining(["444", "485", "417/462", "482"]));
    expect(au.clearanceLevels).toEqual(["Baseline", "NV1", "NV2", "PV"]);
    expect(marketPack("FR").country).toBe("FR");
  });

  it("has an English and Korean label for every work-right option", () => {
    const enLabels = (en as { markets: { workRights: Record<string, string> } }).markets.workRights;
    const koLabels = (ko as { markets: { workRights: Record<string, string> } }).markets.workRights;
    for (const id of [...allWorkRightOptionIds(), "unknown"]) {
      expect(enLabels[id], id).toBeTruthy();
      expect(koLabels[id], id).toBeTruthy();
    }
  });
});
