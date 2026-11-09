import type Anthropic from "@anthropic-ai/sdk";
import { marketPack } from "@/shared/markets";
import { resolveTaskModel } from "@/shared/ai-settings";
import { stableStringify } from "@/shared/stable-json";
import type { ProfileData } from "@/shared/schemas/profile";
import { tailoredCvSchema, type CvLanguage, type TailoredCvOutput } from "@/shared/schemas/cv";
import { callStructured, settingsFor, type AiContext } from "../client";
import { TRUTH_RULES, tailoringProfileView } from "./tailor-cv";

export const BASE_CV_PROMPT_VERSION = 1;

const LANGUAGE_NAMES: Record<string, string> = { en: "English", ko: "Korean" };

const SYSTEM = `You write the content of a candidate's base CV for Huntloop, a job-search assistant. The candidate built their profile in an interview: the CV text is their "Career record" and each role's highlights are their own answers, word for word. One base CV serves their target roles and market, not a single job; Huntloop tailors it to each job later.

Code adds the name, contact details, job titles, companies, dates, education, certifications, languages, work rights and referees from the candidate's profile — do not write those. You write:
- "summary": 2–4 short lines for the top of the CV, aimed at the target roles.
- "roles": for each role id, bullets in the order that best shows the candidate's strengths for the target. "deep" roles 4–6 bullets, "brief" roles 2–3. Achievement-first, verb-first, one idea per bullet, no first person.
- "skills": up to 20 skill names copied exactly from the candidate's skill lists (their skills and each role's skills), most relevant to the target first.
"requirementIds" is always an empty list here (there is no job posting).

The interview answers are tagged by topic in the Career record (scope, responsibility, achievement, tool…). A responsibility must stay a responsibility: never present it as a result. Numbers appear exactly as the candidate wrote them in the quote.

${TRUTH_RULES}`;

export interface BaseCvInput {
  profile: { cvText: string; data: ProfileData };
  target: { titles: string[]; seniority: string[]; country: string };
  /** Role id → how much space it gets. */
  depth: Record<string, "deep" | "brief">;
  language: CvLanguage;
}

type Messages = { system: Anthropic.Beta.Messages.BetaTextBlockParam[]; messages: Anthropic.Beta.Messages.BetaMessageParam[] };

export function buildBaseCvMessages(input: BaseCvInput): Messages {
  const pack = marketPack(input.target.country);
  const target = {
    titles: input.target.titles,
    seniority: input.target.seniority,
    roles: input.profile.data.experience.map((e) => ({ id: e.id, depth: input.depth[e.id] ?? "brief" })),
    market: {
      country: pack.country,
      spelling: input.language === "en" ? pack.cv.spelling : null,
      pages: `${pack.cv.pages[0]}–${pack.cv.pages[1]}`,
      referees: pack.cv.referees ? "code adds 'References available on request'" : "none",
      workRights: pack.cv.workRightsLine ? "code adds the candidate's work rights near the top" : "not shown",
    },
  };
  const spelling = input.language === "en" ? ` with ${pack.cv.spelling} spelling` : "";
  return {
    system: [{ type: "text", text: SYSTEM }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: `<candidate_profile>\n${stableStringify(tailoringProfileView(input.profile.cvText, input.profile.data), 1)}\n</candidate_profile>`, cache_control: { type: "ephemeral" } },
          {
            type: "text",
            text: [
              `<target>\n${stableStringify(target, 1)}\n</target>`,
              `CV language: ${LANGUAGE_NAMES[input.language]} (${input.language})${spelling}. Quotes stay verbatim in their original language.`,
              "Write the base CV.",
            ].join("\n\n"),
          },
        ],
      },
    ],
  };
}

export async function writeBaseCv(ctx: AiContext, input: BaseCvInput): Promise<{ output: TailoredCvOutput; model: string; simulated: boolean }> {
  const { model, effort } = resolveTaskModel(settingsFor(ctx), "buildBaseCv");
  const { system, messages } = buildBaseCvMessages(input);
  const { data, simulated } = await callStructured(ctx, "buildBaseCv", { schema: tailoredCvSchema, system, messages }, { model, effort, enforceBudget: true });
  return { output: data, model, simulated };
}
