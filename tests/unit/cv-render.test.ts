import fs from "node:fs";
import mammoth from "mammoth";
import { extractText } from "unpdf";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cvTranslator, formatCvDate } from "@/server/cv/i18n";
import { cvPlainText, renderCvHtml } from "@/server/cv/render";
import { buildCvDocx } from "@/server/cv/render-docx";
import { htmlToPdf } from "@/server/browser/pdf";
import type { CvDocument, CvLine } from "@/shared/schemas/cv";

const line = (id: string, text: string): CvLine => ({ id, text, sourceRefs: [], requirementIds: [], origin: "ai" });

export function sampleCv(partial: Partial<CvDocument> = {}): CvDocument {
  return {
    language: "en",
    locale: "en-AU",
    market: "AU",
    paper: "A4",
    pages: [2, 3],
    header: { name: "Jamie Park", headline: "Senior Frontend Engineer", email: "jamie@example.com", phone: "0400 000 000", city: "Sydney", country: "AU", links: ["github.com/jamie"] },
    summary: [line("summary-0", "Frontend engineer with seven years of React and TypeScript experience.")],
    skills: ["React", "TypeScript", "GraphQL"],
    roles: [
      {
        experienceId: "exp-1",
        title: "Senior Frontend Engineer",
        company: "Harbour Payments",
        location: "Sydney",
        start: "2021-03",
        end: null,
        bullets: [line("exp-1-b0", "Led the rebuild of the merchant dashboard in React and TypeScript, cutting page load time by 40%."), line("exp-1-b1", "Mentored 4 engineers <and> reviewers.")],
      },
      { experienceId: "exp-2", title: "Frontend Engineer", company: "Koala Commerce", location: "Sydney", start: "2018-01", end: "2021-02", bullets: [line("exp-2-b0", "Built checkout flows in React.")] },
    ],
    education: [{ institution: "Korea University", degree: "BSc", field: "Computer Science", start: null, end: "2016" }],
    certifications: [{ name: "AWS Certified Developer", issuer: "Amazon", year: "2022" }],
    languages: [
      { language: "Korean", level: "native" },
      { language: "English", level: "fluent" },
    ],
    clearances: [{ level: "Baseline", status: "active" }],
    workRight: { status: "permanent_resident", country: "AU" },
    referees: true,
    ...partial,
  };
}

const squash = (s: string) => s.replace(/[•\s]+/g, " ").trim();

describe("CV rendering", () => {
  it("formats dates and labels in the CV's language", () => {
    expect(formatCvDate("2021-03", "en-AU")).toBe("Mar 2021");
    expect(formatCvDate("2021-03", "ko-KR")).toBe("2021년 3월");
    expect(formatCvDate("2016", "en-AU")).toBe("2016");
    const text = cvPlainText(sampleCv(), cvTranslator("en"));
    expect(text).toContain("Permanent resident of Australia");
    expect(text).toContain("Senior Frontend Engineer — Harbour Payments\nSydney · Mar 2021 – Present");
    expect(text).toContain("Korean (native) · English (fluent)");
    expect(text).toContain("References available on request");
    const ko = cvPlainText(sampleCv({ language: "ko", locale: "ko-KR", referees: false }), cvTranslator("ko"));
    expect(ko).toContain("경력");
    expect(ko).toContain("2021년 3월 – 현재");
    expect(ko).toContain("오스트레일리아 영주권자");
    expect(ko).not.toContain("추천인");
  });

  it("states work rights the way the market says them", () => {
    const au = sampleCv({ workRight: { status: "citizen", country: "AU", option: "au_citizen" } });
    expect(cvPlainText(au, cvTranslator("en"))).toContain("Australian citizen");
    expect(cvPlainText(au, cvTranslator("en"))).not.toContain("Australia citizen");
    expect(cvPlainText({ ...au, language: "ko", locale: "ko-KR" }, cvTranslator("ko"))).toContain("호주 시민권자");
    // Drafts made before the option was kept, and countries without a market pack.
    expect(cvPlainText(sampleCv({ workRight: { status: "citizen", country: "SG" } }), cvTranslator("en"))).toContain("Citizen of Singapore");
    expect(cvPlainText(sampleCv({ workRight: { status: "unrestricted_visa", country: "CA", option: "open_work_permit" } }), cvTranslator("en"))).toContain("Full working rights in Canada");
  });

  it("escapes every value in the HTML and highlights only the lines asked for", () => {
    const html = renderCvHtml(sampleCv(), cvTranslator("en"), { highlight: new Set(["exp-1-b1"]) });
    expect(html).toContain("Mentored 4 engineers &lt;and&gt; reviewers.");
    expect(html).not.toContain("<and>");
    expect(html).toContain('<li class="flag" data-line="exp-1-b1">');
    expect(html).toContain("@page { size: A4;");
    expect(renderCvHtml(sampleCv({ paper: "Letter" }), cvTranslator("en"))).toContain("@page { size: Letter;");
    expect(renderCvHtml(sampleCv(), cvTranslator("en"))).not.toContain('class="flag"');
  });

  it("writes a Word file with the same text", async () => {
    const t = cvTranslator("en");
    const docx = await buildCvDocx(sampleCv(), t);
    expect(docx.subarray(0, 2).toString()).toBe("PK");
    const { value } = await mammoth.extractRawText({ buffer: docx });
    expect(squash(value)).toBe(squash(cvPlainText(sampleCv(), t)));
    const ko = await mammoth.extractRawText({ buffer: await buildCvDocx(sampleCv({ language: "ko", locale: "ko-KR" }), cvTranslator("ko")) });
    expect(ko.value).toContain("보유 기술");
  });
});

const CHROMIUM = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? "/opt/pw-browsers/chromium";
const savedPath = process.env.HUNTLOOP_BROWSER_PATH;

describe.skipIf(!fs.existsSync(CHROMIUM))("CV PDF (headless Chromium)", () => {
  beforeAll(() => {
    process.env.HUNTLOOP_BROWSER_PATH = CHROMIUM;
  });
  afterAll(() => {
    if (savedPath === undefined) delete process.env.HUNTLOOP_BROWSER_PATH;
    else process.env.HUNTLOOP_BROWSER_PATH = savedPath;
  });

  it("prints the HTML to a PDF with the same words", async () => {
    const doc = sampleCv();
    const pdf = await htmlToPdf(renderCvHtml(doc, cvTranslator("en")), doc.paper);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const { totalPages, text } = await extractText(new Uint8Array(pdf), { mergePages: true });
    expect(totalPages).toBeGreaterThanOrEqual(1);
    expect(squash(text)).toContain("Jamie Park");
    expect(squash(text)).toContain("cutting page load time by 40%");
  }, 60_000);
});
