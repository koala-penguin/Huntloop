import { CONTROL, type FormCardStage, type InterviewTopic } from "@/shared/schemas/interview";
import { ENUM_WORDS, dateMentions, enumIn, hasPresentWord } from "@/shared/interview-dates";
import { isNoneReply } from "@/shared/interview-openings";
import { containsHangul, type FakeRequest } from "../transport";

/**
 * Demo-mode interviewer for the data steps (target job, roles, education, languages) and the
 * intake of the current-situation chat: simple parsers read job titles, employers and dates out of
 * what the candidate typed and propose them as a card; the questions follow a short plan and pick
 * up the previous reply. Deterministic, so tests and the e2e suite can drive every step without a key.
 */

export type Block = Record<string, unknown> & { type: string };
export type Message = FakeRequest["body"]["messages"][number];

export const blocksOf = (message: { content: unknown }): Block[] =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? (message.content as Block[]) : [];

const CONTEXT = /^<(context_update|interview_form|timeline|this_conversation|recorded_answers|market_notes)>/;
export const isTyped = (b: Block) => b.type === "text" && !CONTEXT.test(String(b.text));
export const typedText = (m: Message) => (m.role === "user" ? blocksOf(m).filter(isTyped).map((b) => String(b.text)).at(-1) : undefined);

let counter = 0;
export const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_demo_interview_${Date.now().toString(36)}_${counter++}`, name, input });

/** tool_use ids whose result was an error, with the error text. */
export function failures(messages: Message[]): Map<string, string> {
  return new Map(messages.flatMap((m) => blocksOf(m).filter((b) => b.type === "tool_result" && b.is_error).map((b) => [String(b.tool_use_id), String(b.content)] as [string, string])));
}

export const snippet = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim().replace(/[.!?]$/, "");
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
};

export interface DataInfo {
  stage: string;
  language: string;
  openingQuestion: string;
  openingTopic: InterviewTopic;
  openingOptions: string[];
}

// ---- Parsers ----

const isControl = (text: string) => Object.values(CONTROL).some((re) => re.test(text.trim()));
const tidy = (text: string) => text.replace(/\s+/g, " ").trim().replace(/^[\s,;:.\-–—]+|[\s,;:.!?\-–—]+$/g, "");

/** "a, b and c" → ["a", "b", "c"]. */
export function splitList(text: string): string[] {
  return text
    .split(/[,;/\n]|\s+and\s+|\s+or\s+|\s*및\s*|\s*그리고\s*/i)
    .map(tidy)
    .filter((item) => item && !isControl(item));
}

const DATE_WORDS = /(?:19|20)\d{2}년(?:\s*\d{1,2}월)?(?:부터|까지)?|(?:19|20)\d{2}(?:[-./]\d{1,2})?(?:부터|까지)?|현재까지|지금까지/g;
const LEAD_IN = /^.*\b(?:i was|i worked as|i work as|working as|work as|i am|i'm|i’m|was|as)(?: an?| the)?\s+/i;
const AFTER_EMPLOYER = /\s+(?:from|since|in|until|between|to|for)\b.*$|\s+\(?(?:19|20)\d{2}.*$|\s*\(.*$/i;

/** "… Frontend Engineer at Koala Commerce, 2018 to 2021": the title nearest " at ", and the employer after it. */
function titleAt(segment: string): { title: string; company: string } | null {
  const m = /([^.,;:]+?)\s+(?:at|@)\s+([^.,;:]+)/i.exec(segment);
  if (m) {
    const title = tidy(m[1].replace(LEAD_IN, ""));
    const company = tidy(m[2].replace(AFTER_EMPLOYER, ""));
    return title ? { title, company } : null;
  }
  // Korean: "카카오에서 데이터 분석가로 …"
  const k = /(.+?)에서\s+(.+?)(?:으로|로)(?=\s|$|[.,])/.exec(segment);
  if (!k) return null;
  const company = tidy(k[1].replace(DATE_WORDS, "").replace(/^(그\s*전에는|이전에는|그리고|구직 중이에요\.?\s*마지막 직장은)\s*/, ""));
  const title = tidy(k[2].replace(DATE_WORDS, ""));
  return title ? { title, company } : null;
}

export function parseCurrent(text: string): { status: string; title: string; company: string; start: string } {
  const status = /between (jobs|roles)|unemployed|구직/i.test(text)
    ? "between_roles"
    : /\bstud(y|ying|ent)\b|학생|공부|재학/i.test(text)
      ? "studying"
      : /\bbreak\b|쉬는|쉬고|휴직/i.test(text)
        ? "on_break"
        : /self[- ]employed|freelanc|프리랜서|자영업/i.test(text)
          ? "self_employed"
          : "employed";
  // The sentence with the job in it ("I'm between jobs. My last job was X at Y" → the second).
  const found = text
    .split(/(?<=[.!?])\s+|\n/)
    .map(titleAt)
    .find(Boolean);
  return { status, title: found?.title ?? "", company: found?.company ?? "", start: dateMentions(text)[0]?.value ?? "" };
}

export interface ParsedRole {
  id: string;
  title: string;
  company: string;
  industry: string;
  location: string;
  start: string;
  end: string;
  current: boolean;
  employment_type: string;
}

/** One role per line or per ";": title and employer, the first date as the start, the second as the end. */
export function parseRoles(text: string): ParsedRole[] {
  return text
    .split(/[;\n]/)
    .map((segment): ParsedRole | null => {
      const found = titleAt(segment);
      if (!found) return null;
      const [start, end] = dateMentions(segment).map((d) => d.value);
      const current = hasPresentWord(segment);
      return { id: "", title: found.title, company: found.company, industry: "", location: "", start: start ?? "", end: current ? "" : (end ?? ""), current, employment_type: enumIn("employmentType", segment) ?? "full_time" };
    })
    .filter((r): r is ParsedRole => r !== null);
}

export function parseEducation(text: string): { education: Array<{ institution: string; degree: string; field: string; start: string; end: string }>; certifications: Array<{ name: string; issuer: string; year: string }> } {
  const education: Array<{ institution: string; degree: string; field: string; start: string; end: string }> = [];
  const certifications: Array<{ name: string; issuer: string; year: string }> = [];
  for (const segment of text.split(/[;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const years = dateMentions(segment).map((d) => d.value);
    const cert = /^(?:cert(?:ification)?s?|자격증)\s*[:：]?\s*(.+)$/i.exec(segment);
    if (cert) {
      const name = tidy(cert[1].split(",")[0].replace(DATE_WORDS, ""));
      if (name) certifications.push({ name, issuer: "", year: years[0]?.slice(0, 4) ?? "" });
      continue;
    }
    const [start, end] = years.length > 1 ? years : ["", years[0] ?? ""];
    const school = /(\S+(?:대학교|대학원|대학|학교))/.exec(segment);
    if (school) {
      const rest = tidy(segment.replace(school[1], "").replace(DATE_WORDS, "").replace(/졸업\S*|전공\S*|수료\S*|에서|을|를/g, " "));
      education.push({ institution: school[1], degree: rest, field: "", start, end });
      continue;
    }
    const m = /^(.+?)\s+(?:at|from)\s+([^,;(]+)/i.exec(segment);
    if (!m) continue;
    const what = tidy(m[1].replace(/^(?:i(?:'ve| have)? (?:have|did|got|studied|completed|finished)|i(?:'ve| have))(?: an?| the| my)?\s+/i, ""));
    const split = /^(.+?)\s+in\s+(.+)$/i.exec(what);
    const institution = tidy(m[2].replace(AFTER_EMPLOYER, ""));
    if (institution) education.push({ institution, degree: split ? tidy(split[1]) : what, field: split ? tidy(split[2]) : "", start, end });
  }
  return { education, certifications };
}

/** "English native, Korean fluent" or "English, native": a language with the level said next to it. */
export function parseLanguages(text: string): Array<{ language: string; level: string }> {
  const out: Array<{ language: string; level: string; said: boolean }> = [];
  for (const token of text.split(/[,;\n]|\s+and\s+|\s*및\s*|\s*그리고\s*/i)) {
    const level = enumIn("languageLevel", token);
    let language = token;
    if (level) language = language.replace(new RegExp(ENUM_WORDS.languageLevel[level].source, "gi"), " ");
    language = tidy(language.replace(/\b(speaker|level|proficiency|i speak|i can work in)\b|수준|입니다|이에요|예요/gi, " "));
    const previous = out.at(-1);
    if (!language && level && previous && !previous.said) {
      previous.level = level;
      previous.said = true;
    } else if (language && !isControl(language)) out.push({ language, level: level ?? "professional", said: !!level });
  }
  return out.map(({ language, level }) => ({ language, level }));
}

const empty = { titles: [] as string[], industries: [] as string[], cities: [] as string[], availability: "", seniority: [] as string[], workplace: [] as string[], employment_types: [] as string[] };

/** Step 0: job titles. Step 1: cities (and "remote"). */
export function parseTarget(text: string, step: number): typeof empty {
  const cleaned = text.replace(/^(?:now\s+)?(?:i'?m|i’m|i am)\s+(?:looking for|after|going for|aiming for)\s+(?:an?\s+)?/i, "").replace(/^이제는\s*/, "").replace(/(?:을\(를\)|을|를)?\s*찾고 있어요\.?$/, "");
  const items = splitList(cleaned);
  if (step === 1) {
    const remote = items.filter((i) => ENUM_WORDS.workplace.remote.test(i));
    return { ...empty, cities: items.filter((i) => !remote.includes(i)), workplace: remote.length ? ["remote"] : [] };
  }
  return { ...empty, titles: items };
}

const count = (value: unknown): number => (Array.isArray(value) ? value.length : value && typeof value === "object" ? Object.values(value).reduce<number>((n, v) => n + count(v), 0) : value ? 1 : 0);

function parseFor(stage: FormCardStage, text: string, step: number): Record<string, unknown> | null {
  const parsed =
    stage === "target"
      ? parseTarget(text, step)
      : stage === "roles"
        ? { roles: parseRoles(text) }
        : stage === "education"
          ? parseEducation(text)
          : stage === "languages"
            ? { languages: parseLanguages(text) }
            : parseCurrent(text);
  if (stage === "current") return (parsed as { title: string }).title || (parsed as { status: string }).status !== "employed" ? parsed : null;
  return count(parsed) ? parsed : null;
}

// ---- The conversation ----

const FOLLOW_UPS: Partial<Record<FormCardStage, { en: string; ko: string }>> = {
  target: { en: "Where do you want to work? Cities, or remote.", ko: "어디에서 일하고 싶으신가요? 도시 이름이나 재택 여부를 알려 주세요." },
  roles: { en: "Any job before that? Same again: job title, employer, dates. Or skip if that's all.", ko: "그 전에 다른 직장도 있었나요? 같은 식으로 직함, 회사, 기간을 알려 주세요. 없으면 건너뛰어도 됩니다." },
};

export function dataInterviewer(req: FakeRequest, conv: DataInfo) {
  const stage = conv.stage as Exclude<FormCardStage, "current">;
  const messages = req.body.messages;
  const last = messages.at(-1);
  const tools = new Set((req.body.tools ?? []).map((t) => String((t as { name?: string }).name)));
  const tool = `propose_${stage}`;
  const failed = failures(messages);
  const said = messages.map(typedText).filter((t): t is string => t !== undefined).at(-1) ?? "";
  const ko = conv.language === "ko" || containsHangul(said);
  const followUp = FOLLOW_UPS[stage];
  /** Roles keep asking for an earlier job until told there is none; the other steps have a fixed number of questions. */
  const repeats = stage === "roles";
  const questions = followUp ? 2 : 1;

  // Replay: each reply that gave something usable, a skip or a "nothing to add" moves the plan on.
  let step = 0;
  let over = false;
  const advance = (stop = false) => {
    step++;
    if (stop || (!repeats && step >= questions)) over = true;
  };
  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      for (const b of blocksOf(m)) {
        if (b.type !== "tool_use" || b.name !== tool) continue;
        const error = failed.get(String(b.id));
        // Something already on file is still an answer to the question.
        if (!error || /already on/.test(error)) advance();
      }
      return;
    }
    const text = typedText(m)?.trim();
    if (text === undefined || i === messages.length - 1) return;
    if (CONTROL.finished.test(text)) over = true;
    else if (CONTROL.skipQuestion.test(text)) advance(repeats && step >= 1);
    else if (isNoneReply(stage, text)) advance(repeats);
  });

  const exhausted = ko ? "여기서 필요한 내용은 다 받았습니다. 카드를 확인한 뒤 계속하기를 눌러 주세요." : "That's what I need here. Check the card, then press Continue.";
  const ask = (lead = "") => {
    if (over) return { content: [{ type: "text", text: `${lead}${exhausted}` }] };
    const opening = step === 0;
    const text = opening ? conv.openingQuestion : ko ? followUp!.ko : followUp!.en;
    const content: Block[] = [{ type: "text", text: `${lead}${text}` }];
    if (opening && tools.has("suggest_options") && conv.openingOptions.length) content.push(toolUse("suggest_options", { options: conv.openingOptions }));
    return { content };
  };

  // After tools ran.
  const results = last?.role === "user" ? blocksOf(last).filter((b) => b.type === "tool_result") : [];
  if (results.length && !blocksOf(last!).some(isTyped)) {
    const previous = [...messages].reverse().find((m) => m.role === "assistant");
    const uses = previous ? blocksOf(previous).filter((b) => b.type === "tool_use").map((b) => String(b.name)) : [];
    // The question and its examples are out: the turn is over.
    if (uses.length && uses.every((n) => n === "suggest_options")) return { content: [] };
    const errors = results.filter((r) => r.is_error).map((r) => String(r.content));
    if (errors.some((e) => /already on/.test(e))) return ask(ko ? "그 내용은 이미 있습니다. " : "I already have that. ");
    if (errors.length) return ask(ko ? `그 내용은 쓸 수 없었습니다: ${errors.join(" ")} ` : `I couldn't use that: ${errors.join(" ")} `);
    const leftOut = /Left out because they did not type it: (.+?)\. Ask/.exec(results.map((r) => String(r.content)).join(" "))?.[1];
    const lead = ko
      ? `"${snippet(said)}" 내용을 아래 카드에 정리했습니다.${leftOut ? " 입력하신 글에서 찾지 못한 항목은 비워 두었습니다." : ""} `
      : `You mentioned "${snippet(said)}": it's on a card below for you to check.${leftOut ? ` I left out the ${leftOut} because I couldn't find it in what you typed.` : ""} `;
    return ask(lead);
  }

  const t = said.trim();
  if (CONTROL.finished.test(t)) {
    over = true;
    return ask();
  }
  if (CONTROL.skipQuestion.test(t)) {
    advance(repeats && step >= 1);
    return ask(ko ? "네, 넘어갈게요. " : "Sure, let's move on. ");
  }
  if (isNoneReply(stage, t)) {
    advance(repeats);
    return ask(ko ? "알겠습니다. " : "Got it. ");
  }
  const parsed = CONTROL.noNumber.test(t) ? null : parseFor(stage, said, step);
  if (parsed && tools.has(tool)) {
    return { content: [{ type: "thinking", thinking: ko ? "입력한 내용을 정리하는 중" : "Reading what you typed", signature: "" }, toolUse(tool, parsed)] };
  }
  return ask(ko ? "조금 더 자세히 말씀해 주실 수 있나요? " : "Could you say a bit more? ");
}
