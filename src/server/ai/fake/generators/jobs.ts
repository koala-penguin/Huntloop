import { registerFakeGenerator, type FakeRequest } from "../transport";
import { KNOWN_SKILLS, mentions } from "./extract-profile";

/**
 * Demo-mode stand-ins for the job pipeline: rough, deterministic parsing so intake, quote checks,
 * scoring and the fit report all run without an API key. Claude does the real work.
 */

export const DEMO_SCREENSHOT_POSTING = `Senior Frontend Engineer
Bright Harbour Health · Sydney NSW (Hybrid)
Full time · $165,000 – $185,000 + super
Posted 2d ago

About the role
Bright Harbour Health is rebuilding its patient booking platform. You will lead frontend delivery for the booking experience used by 400 clinics across Australia.

What you'll bring
• 5+ years of professional frontend development experience
• Strong React and TypeScript skills
• Experience with accessibility (WCAG 2.2) in production web apps
• Experience mentoring other engineers
• Experience with GraphQL is a plus
• Healthcare or regulated industry experience is desirable

You must have full working rights in Australia. We are unable to offer visa sponsorship for this role.

How to apply
Apply with your CV and a short note about a product you are proud of.`;

type Block = Record<string, unknown>;

function userBlocks(req: FakeRequest): Block[] {
  return req.body.messages
    .filter((m) => m.role === "user")
    .flatMap((m) => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as Block[]) : []));
}

function textOf(req: FakeRequest): string {
  return userBlocks(req)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text))
    .join("\n");
}

function json(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// ---------------------------------------------------------------------------------------------
// transcribePosting

registerFakeGenerator("transcribePosting", (req) => {
  const pdfText = /<pdf_text>\n([\s\S]*?)\n<\/pdf_text>/.exec(textOf(req))?.[1];
  return json({ isJobPosting: true, transcription: pdfText?.trim() || DEMO_SCREENSHOT_POSTING, illegible: [] });
});

// ---------------------------------------------------------------------------------------------
// analyzePosting

const CITIES: Array<[RegExp, string, string]> = [
  [/\bsydney\b/i, "Sydney", "AU"], [/\bmelbourne\b/i, "Melbourne", "AU"], [/\bbrisbane\b/i, "Brisbane", "AU"], [/\bperth\b/i, "Perth", "AU"],
  [/\badelaide\b/i, "Adelaide", "AU"], [/\bcanberra\b/i, "Canberra", "AU"], [/\bhobart\b/i, "Hobart", "AU"], [/\bauckland\b/i, "Auckland", "NZ"],
  [/\bwellington\b/i, "Wellington", "NZ"], [/\bchristchurch\b/i, "Christchurch", "NZ"], [/\bsingapore\b/i, "Singapore", "SG"],
  [/\bnew york\b/i, "New York", "US"], [/\bsan francisco\b/i, "San Francisco", "US"], [/\bseattle\b/i, "Seattle", "US"], [/\baustin\b/i, "Austin", "US"],
  [/\bboston\b/i, "Boston", "US"], [/\blondon\b/i, "London", "GB"], [/서울|\bseoul\b/i, "Seoul", "KR"],
];
const COUNTRY_WORDS: Array<[RegExp, string]> = [
  [/\baustralia\b/i, "AU"], [/\bnew zealand\b/i, "NZ"], [/\bsingapore\b/i, "SG"], [/\bunited states\b|\busa\b/i, "US"], [/\bunited kingdom\b/i, "GB"], [/대한민국|한국/, "KR"],
];
const CURRENCY: Record<string, string> = { AU: "AUD", NZ: "NZD", SG: "SGD", US: "USD", GB: "GBP", KR: "KRW" };
const TITLE_WORDS = /engineer|developer|analyst|designer|manager|scientist|architect|consultant|specialist|lead|officer|coordinator|administrator|개발자|엔지니어|디자이너|매니저/i;

function toCountry(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^[A-Za-z]{2}$/.test(value.trim())) return value.trim().toUpperCase();
  return COUNTRY_WORDS.find(([re]) => re.test(value))?.[1] ?? null;
}

function words(text: string, max: number): string {
  return text.split(/\s+/).slice(0, max).join(" ");
}

/** A short label for a requirement line: "Experience mentoring other engineers" → "mentoring other engineers". */
function label(line: string): string {
  const core = line
    .replace(/^(strong|solid|proven|excellent|good|demonstrated|hands-on)\s+/i, "")
    .replace(/^(experience|knowledge|familiarity|skills?|background)\s+(with|in|of)?\s*/i, "")
    .replace(/\s+(is a plus|is desirable|is a bonus|would be (great|nice)|preferred)\.?$/i, "")
    .replace(/\s+(in|for|with|across)\s+.*$/i, "")
    .replace(/[.,;:]+$/, "");
  return words(core || line, 5);
}

function classify(line: string): { kind: "gate" | "must" | "nice"; category: string; gate: string; minYears: number | null; normalized: string } {
  const years = /(\d+)\s*\+?\s*(?:years|yrs)|(\d+)\s*년/i.exec(line);
  const nice = /\b(a plus|bonus|nice to have|desirable|preferred|ideally|advantageous)\b|우대/i.test(line);
  const skill = KNOWN_SKILLS.find(([name]) => mentions(line, name))?.[0];
  if (/\bcitizen/i.test(line)) {
    const pr = /permanent resident|\bPR\b/i.test(line);
    return { kind: "gate", category: "work_rights", gate: pr ? "pr" : "citizenship", minYears: null, normalized: pr ? "Citizenship or PR" : "Citizenship" };
  }
  if (/working rights|right to work|work rights|eligible to work|sponsor/i.test(line)) {
    return { kind: "gate", category: "work_rights", gate: "no_sponsorship", minYears: null, normalized: "Full working rights" };
  }
  if (/\bbaseline\b|\bnv1\b|\bnv2\b|negative vetting|security clearance/i.test(line)) {
    return { kind: "gate", category: "clearance", gate: "clearance", minYears: null, normalized: /nv2/i.test(line) ? "NV2 clearance" : /nv1/i.test(line) ? "NV1 clearance" : "Baseline clearance" };
  }
  if (/driver'?s? licen[cs]e|\blicen[cs]e\b|registration/i.test(line)) return { kind: "gate", category: "license", gate: "license", minYears: null, normalized: "Licence" };
  if (years) {
    const n = Number(years[1] ?? years[2]);
    return { kind: nice ? "nice" : "must", category: "years", gate: "none", minYears: n, normalized: `${n}+ years${skill ? ` ${skill}` : ""}` };
  }
  if (/degree|bachelor|master|phd|diploma|학위/i.test(line)) return { kind: nice ? "nice" : "must", category: "education", gate: "none", minYears: null, normalized: "Degree" };
  if (/certif/i.test(line)) return { kind: nice ? "nice" : "must", category: "certification", gate: "none", minYears: null, normalized: words(line, 4) };
  if (/industry|domain|sector|healthcare|fintech|banking/i.test(line)) return { kind: nice ? "nice" : "must", category: "domain", gate: "none", minYears: null, normalized: label(line) };
  return { kind: nice ? "nice" : "must", category: "skill", gate: "none", minYears: null, normalized: skill ?? label(line) };
}

/** "Title — Company, City" on one line, or the company first on the line after the title. */
function titleAndCompany(lines: string[], hints: Record<string, unknown>): { title: string; company: string | null } {
  const index = lines.findIndex((l) => TITLE_WORDS.test(l) && l.length < 90);
  const line = index >= 0 ? lines[index] : (lines[0]?.slice(0, 80) ?? "Job");
  const [head, ...rest] = line.split(/\s+[—–|]\s+|\s+-\s+|\s+at\s+/);
  const notCompany = (s: string) => !s || CITIES.some(([re]) => re.test(s)) || /hybrid|remote|full time|part time|contract|\$/i.test(s);
  let company = rest.length ? rest.join(" ").split(/,|·/)[0].trim() : null;
  if (!company && index >= 0 && lines[index + 1]) company = lines[index + 1].split(/\s+[·|—–]\s+|,/)[0].trim();
  if (company && notCompany(company)) company = null;
  return {
    title: (typeof hints.title === "string" && hints.title) || head.trim() || "Job",
    company: (typeof hints.company === "string" && hints.company) || company,
  };
}

export function fakePostingAnalysis(text: string, hints: Record<string, unknown>, today: string) {
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const { title, company } = titleAndCompany(lines, hints);
  const cityHit = CITIES.find(([re]) => re.test(String(hints.city ?? "")) || re.test(String(hints.locationText ?? ""))) ?? CITIES.find(([re]) => re.test(text));
  const country = toCountry(hints.country) ?? cityHit?.[2] ?? COUNTRY_WORDS.find(([re]) => re.test(text))?.[1] ?? null;
  const workplace = hints.workplace ?? (/hybrid/i.test(text) ? "hybrid" : /\bremote\b/i.test(text) ? "remote" : /on-?site|in the office/i.test(text) ? "onsite" : "unknown");
  const employmentType = /\bcontract\b/i.test(text) ? "contract" : /part[- ]time/i.test(text) ? "part_time" : /full[- ]time|permanent/i.test(text) ? "full_time" : "unknown";
  const seniority = /\b(principal)\b/i.test(title) ? "principal" : /\b(lead|staff)\b/i.test(title) ? "lead" : /\b(senior|sr\.?)\b/i.test(title) ? "senior" : /\b(junior|graduate|jr\.?)\b/i.test(title) ? "junior" : null;
  const salaryMatch = /\$\s?(\d{2,3})(?:,(\d{3})|k)\s*[-–]\s*\$?\s?(\d{2,3})(?:,(\d{3})|k)/i.exec(text);
  const salary = salaryMatch
    ? {
        min: Number(salaryMatch[1]) * 1000,
        max: Number(salaryMatch[3]) * 1000,
        currency: country ? (CURRENCY[country] ?? null) : null,
        period: "year",
        basis: /\+\s*super/i.test(text) ? "base_plus_super" : /package|incl\.? super/i.test(text) ? "package" : "unknown",
        text: salaryMatch[0],
      }
    : null;
  const sponsorLine = lines.find((l) => /sponsor|working rights|right to work/i.test(l)) ?? null;
  const sponsorship = sponsorLine ? (/unable|not|no |cannot|must have full/i.test(sponsorLine) ? "not_offered" : /available|will sponsor|provided/i.test(sponsorLine) ? "offered" : "unknown") : "unknown";
  const posted = /posted\s+(\d+)\s*(d|days?|h|hours?)\s+ago/i.exec(text);
  const postedDate = posted ? new Date(Date.parse(today) - (posted[2].startsWith("h") ? 0 : Number(posted[1]) * 86_400_000)).toISOString().slice(0, 10) : (typeof hints.postedAt === "string" ? hints.postedAt.slice(0, 10) : null);

  const candidates = lines
    .flatMap((l) => (/^[•\-*·▪●◦]\s*|^\d+[.)]\s+/.test(l) ? [l.replace(/^[•\-*·▪●◦]\s*|^\d+[.)]\s+/, "")] : /must|required|citizen|clearance|working rights|right to work|sponsor/i.test(l) ? l.split(/(?<=[.!])\s+/) : []))
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && !/^how to apply/i.test(l) && /must|required|experience|skills|years|citizen|clearance|rights|sponsor|knowledge|degree|ability|familiar|proficien|licen|plus|desirable|bonus|\b[A-Z][a-zA-Z.+#]+\b/.test(l))
    .slice(0, 20);
  const requirements = candidates.map((line) => ({ postingQuote: words(line, 25), ...classify(line) }));

  return {
    isJobPosting: requirements.length > 0 || /responsibilit|requirement|apply|role|position|자격|담당/i.test(text),
    postingStart: null,
    postingEnd: null,
    title,
    company,
    companyDomain: null,
    locationText: (typeof hints.locationText === "string" && hints.locationText) || (cityHit ? cityHit[1] : null),
    city: (typeof hints.city === "string" && hints.city) || cityHit?.[1] || null,
    region: null,
    country,
    countryEvidence: cityHit ? cityHit[1] : null,
    workplace: ["onsite", "hybrid", "remote"].includes(String(workplace)) ? workplace : "unknown",
    remoteScope: null,
    employmentType,
    seniority,
    salary,
    postedText: posted?.[0] ?? null,
    postedDate,
    closesDate: null,
    language: /[ㄱ-힝]/.test(text) ? "ko" : "en",
    sponsorship,
    sponsorshipQuote: sponsorLine ? words(sponsorLine, 25) : null,
    requirements,
    ghostSignals: /talent pool|expression of interest|always looking/i.test(text) ? ["Evergreen / talent-pool wording"] : [],
  };
}

registerFakeGenerator("analyzePosting", (req) => {
  const doc = userBlocks(req).find((b) => b.type === "document") as { source?: { data?: string } } | undefined;
  const text = doc?.source?.data ?? textOf(req);
  const extra = textOf(req);
  const hints = (() => {
    const m = /Structured data published with the posting \(may be incomplete\): (\{.*\})/.exec(extra);
    try {
      return m ? (JSON.parse(m[1]) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })();
  const today = /Today's date: (\d{4}-\d{2}-\d{2})/.exec(extra)?.[1] ?? new Date().toISOString().slice(0, 10);
  return json(fakePostingAnalysis(text, hints, today));
});

// ---------------------------------------------------------------------------------------------
// assess

interface FakeProfile {
  cvText: string;
  experience: Array<{ id: string; title: string; seniority: string | null; industry: string | null }>;
  facts: Array<{ id: string; text: string }>;
}
interface FakeJob {
  title: string;
  company: string | null;
  language: string;
  requirements: Array<{ id: string; postingQuote: string; kind: string; category: string; minYears: number | null; normalized: string }>;
}

function between(text: string, tag: string): string | null {
  return new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text)?.[1] ?? null;
}

export function fakeAssessment(profile: FakeProfile, job: FakeJob, language: string) {
  const ko = language === "ko";
  const cvLines = profile.cvText.split(/\n+/).map((l) => l.trim()).filter((l) => l && !/\[(email|phone|link|name)\]/.test(l));
  const term = (r: FakeJob["requirements"][number]) => r.normalized.replace(/^\d+\+?\s*years\s*/i, "").trim();
  const items = job.requirements.map((r) => {
    const t = term(r);
    if (r.category === "years") {
      const line = cvLines.find((l) => /\d{4}/.test(l)) ?? null;
      return {
        requirementId: r.id,
        evidence: line ? [{ source: "cv", quote: line, factId: null }] : [],
        experienceIds: profile.experience.map((e) => e.id),
        reasoning: ko ? "경력 기간은 날짜가 있는 경력 항목으로 계산합니다." : "Years are computed from your dated roles.",
        status: "partial",
        gapType: "none",
        question: null,
        postingQuoteGloss: ko && job.language !== "ko" ? `최소 ${r.minYears}년 경력` : null,
      };
    }
    const cvLine = t.length > 1 ? cvLines.find((l) => mentions(l, t)) : undefined;
    const fact = t.length > 1 ? profile.facts.find((f) => mentions(f.text, t)) : undefined;
    const met = cvLine || fact;
    return {
      requirementId: r.id,
      evidence: cvLine ? [{ source: "cv", quote: cvLine, factId: null }] : fact ? [{ source: "fact", quote: fact.text, factId: fact.id }] : [],
      experienceIds: [],
      reasoning: met ? (ko ? `프로필에서 ${t} 관련 근거를 찾았습니다.` : `Your profile shows ${t}.`) : ko ? `프로필에 ${t}에 대한 언급이 없습니다.` : `Your profile doesn't mention ${t}.`,
      status: met ? "met" : "unknown",
      gapType: met ? "none" : "not_on_cv",
      question: met ? null : ko ? `${t} 경험이 있나요?` : `Do you have this: ${t}?`,
      postingQuoteGloss: ko && job.language !== "ko" ? `${t} 요구사항` : null,
    };
  });
  const recent = profile.experience[0];
  const mainWord = (s: string) => /engineer|developer|analyst|designer|manager|scientist|architect/i.exec(s)?.[0]?.toLowerCase();
  const titleRelevance = recent && mainWord(recent.title) && mainWord(recent.title) === mainWord(job.title) ? "same" : recent ? "adjacent" : "different";
  const metItems = items.filter((i) => i.status === "met");
  const name = (id: string) => job.requirements.find((r) => r.id === id)?.normalized ?? id;
  return {
    items,
    candidateSeniority: recent?.seniority ?? null,
    titleRelevance,
    industryRelevance: "adjacent",
    strengths: metItems.slice(0, 3).map((i) => ({ text: ko ? `CV에 ${name(i.requirementId)} 경험이 나와 있습니다.` : `Your CV shows ${name(i.requirementId)}.`, requirementIds: [i.requirementId] })),
    boosters: [
      { kind: "keywords", text: ko ? "공고에 쓰인 표현 그대로 CV에 핵심 기술을 적으세요." : "Use the posting's exact wording for your key skills on your CV." },
      { kind: "apply_early", text: ko ? "공고 초기에 지원하면 검토될 가능성이 높아집니다." : "Apply early — recruiters review the first applicants most closely." },
    ],
    risks: items.some((i) => i.status !== "met")
      ? [{ kind: "underqualified", text: ko ? "CV에 드러나지 않은 요구사항이 있습니다. 요구사항 옆의 질문에 답해 주세요." : "Some requirements aren't visible on your CV yet — answer the questions next to them." }]
      : [],
    oneLine: ko
      ? `평가한 요구사항 ${items.length}개 중 ${metItems.length}개를 충족합니다 (데모 평가).`
      : `You meet ${metItems.length} of ${items.length} assessed requirements (demo assessment).`,
    postingSummary: ko
      ? `${job.company ?? "이 회사"}의 ${job.title} 포지션입니다. 데모 모드에서는 간단한 규칙으로 분석합니다.`
      : `${job.title}${job.company ? ` at ${job.company}` : ""}. In demo mode Huntloop uses simple rules instead of Claude.`,
  };
}

registerFakeGenerator("assess", (req) => {
  const text = textOf(req);
  const profile = JSON.parse(between(text, "candidate_profile") ?? "{}") as FakeProfile;
  const job = JSON.parse(between(text, "job") ?? "{}") as Partial<FakeJob>;
  const language = /Output language[^(]*\((\w+)\)/.exec(text)?.[1] ?? "en";
  return json(fakeAssessment({ cvText: profile.cvText ?? "", experience: profile.experience ?? [], facts: profile.facts ?? [] }, { requirements: job.requirements ?? [], language: job.language ?? "en", title: job.title ?? "", company: job.company ?? null }, language));
});

// ---------------------------------------------------------------------------------------------
// translate

registerFakeGenerator("translate", (req) => {
  const text = textOf(req);
  const language = /Target language: [^(]*\((\w+)\)/.exec(text)?.[1] ?? "en";
  const items = JSON.parse(between(text, "items") ?? "[]") as Array<{ id: string; text: string }>;
  return json({ items: items.map((i) => ({ id: i.id, text: `[${language}] ${i.text}` })) });
});
