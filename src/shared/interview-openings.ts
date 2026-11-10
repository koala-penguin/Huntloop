import { countryName } from "./countries";
import { EARLIER_ROLES, roleFamily } from "./role-suggestions";
import { currentRole, type ChatOpening, type FormCardStage, type InterviewForm } from "./schemas/interview";

/**
 * The first question of each data step (target job, where you are now, roles, education,
 * languages), built from what is already on file, with a few sentence starters. Like every example
 * in the interview, the starters only fill the reply box and carry no digits.
 */

type Lang = "en" | "ko";

/**
 * Replies that answer the question without giving anything to save ("That's my only job so far").
 * The openings offer them as chips; the demo interviewer moves on when it gets one.
 */
export const NONE_REPLIES: Record<FormCardStage, Record<Lang, string[]>> = {
  target: { en: ["Yes, that's still it"], ko: ["네, 그대로예요"] },
  current: { en: ["I'm studying", "I'm taking a break"], ko: ["공부하고 있어요", "쉬고 있어요"] },
  roles: { en: ["That's my only job so far"], ko: ["지금 직장이 첫 직장이에요"] },
  education: { en: ["No formal qualifications"], ko: ["정규 학력은 없어요"] },
  languages: { en: [], ko: [] },
};

const plain = (text: string) => text.trim().replace(/[.!?。]+$/, "").replace(/[’‘]/g, "'").toLowerCase();

/** Whether a reply is one of the step's "nothing to add" answers (in either language). */
export function isNoneReply(stage: FormCardStage, text: string): boolean {
  return [...NONE_REPLIES[stage].en, ...NONE_REPLIES[stage].ko].some((reply) => plain(reply) === plain(text));
}

const LANGUAGE_NAMES: Record<Lang, Record<string, string>> = { en: { en: "English", ko: "Korean" }, ko: { en: "영어", ko: "한국어" } };
const noDigits = (options: string[]) => options.filter((o) => o.trim() && !/\d/.test(o));

export interface DataOpeningInput {
  stage: FormCardStage;
  form: InterviewForm;
  /** The interview's language. */
  language: string;
}

export function dataOpeningFor({ stage, form, language }: DataOpeningInput): ChatOpening {
  const lang: Lang = language === "ko" ? "ko" : "en";
  const ko = lang === "ko";
  const none = NONE_REPLIES[stage][lang];
  const opening = (text: string, options: string[]): ChatOpening => ({ text, options: noDigits(options), topic: "other" });

  switch (stage) {
    case "target": {
      const titles = form.target.titles.filter((t) => t.trim());
      const cities = form.target.cities.filter((c) => c.trim());
      if (!titles.length) return opening(ko ? "다음에는 어떤 일을 하고 싶으신가요? 직함 한두 개면 시작하기에 충분합니다." : "What job are you going for next? One or two job titles is enough to start.", []);
      const list = titles.slice(0, 3).join(", ");
      const where = cities.slice(0, 3).join(", ");
      return opening(
        ko
          ? `저장된 검색 조건은 ${list}${where ? ` (${where})` : ""}입니다. 여전히 이 일을 찾고 계신가요, 아니면 바뀌었나요?`
          : `Your saved search is for ${list}${where ? ` in ${where}` : ""}. Is that still the job you're after, or has it changed?`,
        [...none, ...(ko ? ["이제는 …을(를) 찾고 있어요"] : ["Now I'm looking for …"])],
      );
    }
    case "current":
      return opening(
        ko
          ? "지금은 무엇을 하고 계신가요? 재직 중인지, 구직 중인지, 공부 중인지, 쉬는 중인지 알려 주세요. 일하고 계시면 직함과 회사도 알려 주세요."
          : "What are you doing right now: working, between jobs, studying or taking a break? If you're working, tell me your job title and employer.",
        ko ? ["…에서 …로 일하고 있어요", "구직 중이에요. 마지막 직장은 …에서 …였어요", ...none] : ["I work as … at …", "I'm between jobs. My last job was … at …", ...none],
      );
    case "roles": {
      const role = currentRole(form);
      if (!role) {
        return opening(
          ko ? "최근 직장부터 차례로 알려 주세요. 직함, 회사, 그리고 언제부터 언제까지 일하셨는지요." : "Walk me through your jobs, newest first: job title, employer, and from when to when.",
          ko ? ["…에서 …로 …부터 …까지 일했어요"] : ["I was … at … from … to …"],
        );
      }
      const earlier = EARLIER_ROLES[roleFamily(role.title)][lang].slice(0, 3);
      const title = role.title.trim() || (ko ? "지금 일" : "your current job");
      const company = role.company.trim();
      return opening(
        ko
          ? `${company ? `${company}의 ` : ""}${title}${role.start ? ` (${role.start}부터)` : ""} 이력이 있습니다. 그 전에는 어떤 일을 하셨나요? 직함, 회사, 대략의 기간을 하나씩 또는 한꺼번에 알려 주세요.`
          : `I have ${title}${company ? ` at ${company}` : ""}${role.start ? ` since ${role.start}` : ""}. What did you do before that? Job title, employer and rough dates, one job at a time or all at once.`,
        [ko ? "그 전에는 …에서 …로 일했어요" : "Before that I was … at …", ...earlier, ...none],
      );
    }
    case "education": {
      const title = form.target.titles.find((t) => t.trim());
      return opening(
        ko
          ? `${title ? `${title} 지원을 염두에 두고 여쭤볼게요. ` : ""}학교를 마친 뒤 무엇을 공부하셨나요? 학위나 과정, 학교, 대략의 시기를 알려 주세요. 자격증도 포함됩니다.`
          : `${title ? `Next, your education, with ${title} roles in mind. ` : ""}What did you study after school? Qualification, where, and roughly when. Certifications count too.`,
        ko ? ["…대학교 …학과 학사", "…에서 … 과정 수료", ...none] : ["Bachelor's degree in … at …", "Diploma in … at …", ...none],
      );
    }
    case "languages": {
      const own = LANGUAGE_NAMES[lang][lang];
      const other = LANGUAGE_NAMES[lang][ko ? "en" : "ko"];
      const country = countryName(form.setup.country, lang);
      return opening(
        ko
          ? `이 인터뷰는 ${own}로 진행 중이고, 목표 지역은 ${country}입니다. 업무에 쓸 수 있는 언어와 그 수준을 알려 주세요.`
          : `You're doing this in ${own} and aiming at ${country}. Which languages can you work in, and how well?`,
        ko ? [`${own}, 원어민`, `${other}, 유창`] : [`${own}, native`, `${other}, fluent`],
      );
    }
  }
}
