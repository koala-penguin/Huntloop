import { registerFakeGenerator, type FakeRequest } from "../transport";
import { between, json, textOf } from "./jobs";

/**
 * Demo-mode CV tailoring and LinkedIn text. Built from the candidate's own CV lines, so quotes verify
 * like Claude's would — plus one deliberately unsupported bullet in each first draft, so the
 * truthfulness checks and the "items to check" flow are visible without an API key.
 */

interface Role {
  id: string;
  title: string;
  company: string;
  skills: string[];
  highlights: string[];
}
interface Profile {
  cvText: string;
  experience: Role[];
  skills: string[];
}
interface JobReq {
  id: string;
  kind: string;
  category: string;
  term: string;
  status: string;
  evidence: Array<{ source: string; quote: string }>;
}

export const DEMO_UNSUPPORTED_BULLET = { en: "Improved release frequency by 25% across 3 squads.", ko: "3개 팀의 배포 주기를 25% 개선했습니다." };

function parse<T>(text: string, tag: string, fallback: T): T {
  try {
    return JSON.parse(between(text, tag) ?? "") as T;
  } catch {
    return fallback;
  }
}

function context(req: FakeRequest) {
  const text = textOf(req);
  const profile = parse<Profile>(text, "candidate_profile", { cvText: "", experience: [], skills: [] });
  const job = parse<{ requirements: JobReq[] }>(text, "job", { requirements: [] });
  const language: "en" | "ko" = /(?:CV language|Language): [^(]*\((\w+)\)/.exec(text)?.[1] === "ko" ? "ko" : "en";
  // The plan's notes follow the interface language; older prompts without it use the CV language.
  const notes = /Notes language: [^(]*\((\w+)\)/.exec(text)?.[1];
  const notesLanguage: "en" | "ko" = notes ? (notes === "ko" ? "ko" : "en") : language;
  return { text, profile, job, language, notesLanguage };
}

const termOf = (r: JobReq) => r.term.replace(/^\d+\+?\s*(years?|yrs?)\s*(of\s+)?/i, "").trim();
const mentions = (text: string, term: string) => term.length > 1 && text.toLowerCase().includes(term.toLowerCase());
const cvRef = (quote: string) => ({ source: "cv" as const, quote, factId: null });

/** A summary-like sentence from the CV (8+ words, no redacted contact details). */
function summarySentence(profile: Profile): string | null {
  const lines = profile.cvText.split(/\n+/).map((l) => l.trim());
  return lines.find((l) => l.split(/\s+/).length >= 8 && !/\[(email|phone|link|name)\]/.test(l) && !profile.experience.some((e) => e.highlights.includes(l))) ?? null;
}

/** The CV line that names a role (e.g. "Senior Frontend Engineer at Harbour Payments — …"). */
function roleLine(profile: Profile, role: Role): string {
  const lines = profile.cvText.split(/\n+/).map((l) => l.trim()).filter((l) => !/\[(email|phone|link|name)\]/.test(l));
  return lines.find((l) => l.includes(role.title) && l.split(/\s+/).length >= 3) ?? `${role.title} ${role.company}`;
}

registerFakeGenerator("planTailoring", (req) => {
  const { profile, job, notesLanguage } = context(req);
  const ko = notesLanguage === "ko";
  const relevant = job.requirements.filter((r) => r.kind !== "gate" && r.category !== "years");
  const met = relevant.filter((r) => r.status === "met" || r.status === "partial");
  const notMet = relevant.filter((r) => r.status === "unmet" || r.status === "unknown");
  const lead = profile.experience[0];
  return json({
    summaryAngle: ko
      ? `${lead?.title ?? "지원자"}로서 공고의 핵심 요구 사항과 맞는 경험을 앞세웁니다.`
      : `Lead with your experience as ${lead?.title ?? "a candidate"} that matches the job's core requirements.`,
    targetRequirementIds: met.map((r) => r.id),
    roles: profile.experience.map((e, i) => ({ experienceId: e.id, include: true, emphasis: i === 0 ? "lead" : i >= 2 ? "brief" : "normal" })),
    keywords: met.filter((r) => r.evidence.length).map((r) => ({ requirementId: r.id, term: termOf(r), supportQuote: r.evidence[0].quote })),
    doNotClaim: notMet.map((r) => ({ requirementId: r.id, reason: ko ? "CV에서 확인되지 않습니다." : "Your CV doesn't show this." })),
    questions: notMet.slice(0, 1).map((r) => ({
      text: ko ? `${termOf(r)} 경험이 있나요? 있다면 어디서 어떻게 사용했나요?` : `Have you worked with ${termOf(r)}? If so, where and how?`,
      requirementId: r.id,
      experienceId: null,
    })),
    linkedinEmphasis: (lead?.highlights ?? []).slice(0, 2).map((h) => ({ section: "experience", text: h, sourceRefs: [cvRef(h)] })),
    advice: notMet.length
      ? [ko ? `자기소개서에서 ${termOf(notMet[0])} 관련 계획이나 비슷한 경험을 설명하세요.` : `Use your cover letter to address ${termOf(notMet[0])} honestly — related experience or how you'd ramp up.`]
      : [],
  });
});

registerFakeGenerator("tailorCv", (req) => {
  const { text, profile, job, language } = context(req);
  const plan = parse<{ targetRequirementIds: string[]; roles: Array<{ experienceId: string; include: boolean; emphasis: string }> }>(text, "plan", { targetRequirementIds: [], roles: [] });
  const revision = between(text, "revision_request");
  const targets = job.requirements.filter((r) => plan.targetRequirementIds.includes(r.id));
  const reqsIn = (line: string) => targets.filter((r) => mentions(line, termOf(r))).map((r) => r.id);
  const limit = { lead: 6, normal: 4, brief: 2 } as Record<string, number>;
  const shorter = !!revision && /short|concise|brief|짧|간결/i.test(revision);

  const roles = profile.experience
    .map((e) => ({ role: e, plan: plan.roles.find((p) => p.experienceId === e.id) }))
    .filter((r) => r.plan?.include !== false)
    .map(({ role, plan: rp }, i) => {
      const ordered = [...role.highlights].sort((a, b) => reqsIn(b).length - reqsIn(a).length);
      const bullets = ordered.slice(0, shorter ? 2 : (limit[rp?.emphasis ?? "normal"] ?? 4)).map((h) => ({ text: h, sourceRefs: [cvRef(h)], requirementIds: reqsIn(h) }));
      if (i === 0 && !revision && role.highlights[0]) {
        bullets.push({ text: DEMO_UNSUPPORTED_BULLET[language], sourceRefs: [cvRef(role.highlights[0])], requirementIds: [] });
      }
      return { experienceId: role.id, bullets };
    });
  const summary = summarySentence(profile);
  const skills = [...profile.skills].sort((a, b) => Number(targets.some((r) => mentions(r.term, b))) - Number(targets.some((r) => mentions(r.term, a))));
  return json({
    summary: summary ? [{ text: summary, sourceRefs: [cvRef(summary)], requirementIds: reqsIn(summary) }] : [],
    skills,
    roles,
  });
});

registerFakeGenerator("linkedinProfile", (req) => {
  const { profile } = context(req);
  const latest = profile.experience[0];
  const summary = summarySentence(profile);
  const headlineSource = latest ? roleLine(profile, latest) : (summary ?? "");
  return json({
    headline: {
      text: [latest?.title, profile.skills.slice(0, 3).join(" · ")].filter(Boolean).join(" | "),
      sourceRefs: [cvRef(headlineSource)],
      requirementIds: [],
    },
    about: summary ? [{ text: summary, sourceRefs: [cvRef(summary)], requirementIds: [] }] : [],
    positions: profile.experience.map((e) => ({ experienceId: e.id, bullets: e.highlights.slice(0, 4).map((h) => ({ text: h, sourceRefs: [cvRef(h)], requirementIds: [] })) })),
    topSkills: profile.skills.slice(0, 5),
  });
});
