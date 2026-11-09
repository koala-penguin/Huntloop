import { termPresent } from "../../../scoring/keywords";
import { polishGate } from "../../../cv/polish";
import { CONTROL, REQUIRED_TOPICS, type InterviewTopic } from "@/shared/schemas/interview";
import { roleFamily, suggestionsFor, type RoleFamily } from "@/shared/role-suggestions";
import { containsHangul, registerFakeGenerator, type FakeRequest } from "../transport";

/**
 * Demo-mode CV interviewer: a fixed plan of topics per part, asked in a conversational way from the
 * role and the candidate's last answer, each with example prompts. Each typed answer is recorded
 * verbatim (and known skill names noted), then a cleaner version is offered. "Skip this question"
 * moves on, "That's all for this part" finishes, short replies get a re-ask. Deterministic, so tests
 * and the e2e suite can drive a whole interview without a key.
 */

type Block = Record<string, unknown> & { type: string };
type Message = FakeRequest["body"]["messages"][number];

const blocksOf = (message: { content: unknown }): Block[] =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? (message.content as Block[]) : [];

const CONTEXT = /^<(context_update|interview_form|timeline|this_conversation|recorded_answers|market_notes)>/;
const isTyped = (b: Block) => b.type === "text" && !CONTEXT.test(String(b.text));
const typedText = (m: Message) => (m.role === "user" ? blocksOf(m).filter(isTyped).map((b) => String(b.text)).at(-1) : undefined);

const SKILLS: Array<[string, string]> = [
  ["React", "framework"],
  ["TypeScript", "language"],
  ["JavaScript", "language"],
  ["Python", "language"],
  ["SQL", "language"],
  ["Excel", "tool"],
  ["Power BI", "tool"],
  ["Tableau", "tool"],
  ["Figma", "tool"],
  ["Jira", "tool"],
  ["Salesforce", "platform"],
  ["AWS", "platform"],
  ["Azure", "platform"],
  ["GraphQL", "tool"],
  ["Snowflake", "database"],
  ["dbt", "tool"],
];

interface Info {
  stage: "current" | "role_deep";
  role: { depth: "deep" | "brief"; title: string } | null;
  about: { title: string; company: string } | null;
  targetTitles: string[];
  language: string;
  openingQuestion: string;
  openingTopic: InterviewTopic;
  openingOptions: string[];
}

function info(req: FakeRequest): Info {
  const text = blocksOf(req.body.messages[0] ?? { content: [] })
    .map((b) => String(b.text ?? ""))
    .join("\n");
  const fallback: Info = { stage: "current", role: null, about: null, targetTitles: [], language: "en", openingQuestion: "", openingTopic: "context", openingOptions: [] };
  try {
    return { ...fallback, ...(JSON.parse(/<this_conversation>\n([\s\S]*?)\n<\/this_conversation>/.exec(text)?.[1] ?? "") as Partial<Info>) };
  } catch {
    return fallback;
  }
}

/** Like the interviewer's own rule: 3+ words, or 4+ Hangul characters. */
const substantial = (text: string) => text.trim().split(/\s+/).length >= 3 || /[\p{Script=Hangul}]{4,}/u.test(text);

/** The demo's cleaner version of an answer: no leading "I", a capital letter, a full stop. */
export function fakePolish(text: string): string {
  let out = text.replace(/\s+/g, " ").trim();
  if (!containsHangul(out)) out = out.replace(/^(i'?ve|i'?m|i was|i am|i)\s+/i, "");
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return /[.!?。]$/.test(out) ? out : `${out}.`;
}

interface Step {
  topic: InterviewTopic;
  private?: boolean;
  text: string;
  options: string[];
}

const WHY_LOOKING = { en: ["Want a bigger role", "Restructure or redundancy", "Want better pay", "Want a new challenge", "Moving cities"], ko: ["더 큰 역할", "구조조정", "더 나은 보상", "새로운 도전", "이사"] };

/** The topics of one part, in order. The first is the opening the app shows. */
function plan(conv: Info, ko: boolean, family: RoleFamily): Step[] {
  const lang = ko ? "ko" : "en";
  const title = conv.about?.title || (ko ? "이 역할" : "this role");
  const s = (topic: InterviewTopic, en: string, kr: string, extra: Partial<Step> = {}): Step => ({ topic, text: ko ? kr : en, options: suggestionsFor(family, topic, lang), ...extra });
  const opening: Step = { topic: conv.openingTopic, text: conv.openingQuestion, options: conv.openingOptions };
  if (conv.stage === "current") {
    return [
      opening,
      s("scope", "Who do you work with and report to, and who reports to you? Please type any numbers as digits.", "누구와 함께 일하고 누구에게 보고하나요? 보고받는 사람은 몇 명인가요? 숫자는 숫자로 적어 주세요."),
      s("achievement", "What are you most proud of in this job so far?", "지금 일에서 가장 자랑스러운 일은 무엇인가요?"),
      s("context", "Why are you looking for a new role? This stays private and never goes on your CV.", "새 일자리를 찾는 이유는 무엇인가요? 이 답은 비공개이며 CV에 들어가지 않습니다.", { private: true, options: WHY_LOOKING[lang] }),
      s("other", "What do you want more of, or less of, in your next job? This is private too.", "다음 직장에서 더 하고 싶은 일, 덜 하고 싶은 일은 무엇인가요? 이것도 비공개입니다.", { private: true }),
    ];
  }
  if (conv.role?.depth === "brief") {
    return [opening, s("achievement", `What's one result from your time as ${title} you'd like on your CV?`, `${title} 시절 CV에 넣고 싶은 성과 하나는 무엇인가요?`)];
  }
  return [
    opening,
    s("scope", "How big was that? Team size, budget, users or systems, whatever fits. Please type numbers as digits.", "규모는 어느 정도였나요? 팀 규모, 예산, 사용자, 시스템 등 맞는 것으로요. 숫자는 숫자로 적어 주세요."),
    s("achievement", `Which result from your time as ${title} are you proudest of? What changed, and by how much?`, `${title} 시절 가장 자랑스러운 성과는 무엇인가요? 무엇이 얼마나 달라졌나요?`),
    s("achievement", "Is there another result worth a line on your CV? A number makes it stronger, typed as digits.", "CV에 넣을 만한 다른 성과도 있나요? 숫자가 있으면 더 좋습니다."),
    s("tool", `Which tools or methods did you lean on most as ${title}?`, `${title}로 일할 때 가장 많이 쓴 도구나 방법은 무엇인가요?`),
    s("context", "Anything else about this job you'd like on your CV?", "이 일에 대해 CV에 더 넣고 싶은 것이 있나요?"),
  ];
}

type StepState = "open" | "answered" | "skipped" | "dropped";

/** Where the conversation stands: which step each part of the plan is at, and what is on the table. */
interface State {
  steps: StepState[];
  asked: number;
  /** All planned steps are answered or skipped twice, but a required topic is still missing. */
  lastCall: boolean;
  finished: boolean;
}

function nextStep(state: State, steps: Step[], required: InterviewTopic[]): { index: number; lastCall: boolean } | null {
  const open = state.steps.indexOf("open");
  if (open >= 0) return { index: open, lastCall: false };
  const answered = new Set(steps.filter((_, i) => state.steps[i] === "answered" && !steps[i].private).map((s) => s.topic));
  const missing = required.filter((t) => !answered.has(t));
  if (!missing.length) return null;
  const again = steps.findIndex((s, i) => missing.includes(s.topic) && state.steps[i] === "skipped");
  if (again >= 0) return { index: again, lastCall: false };
  return { index: steps.findIndex((s) => missing.includes(s.topic)), lastCall: true };
}

/** One typed message moves the state on (the reply to it is worked out separately). */
function apply(state: State, text: string, steps: Step[], required: InterviewTopic[]): State {
  const t = text.trim();
  if (state.finished) return state;
  if (CONTROL.finished.test(t)) return { ...state, finished: true };
  const stepsNow = [...state.steps];
  if (CONTROL.skipQuestion.test(t) || CONTROL.noNumber.test(t)) stepsNow[state.asked] = stepsNow[state.asked] === "open" ? "skipped" : "dropped";
  else if (substantial(t)) stepsNow[state.asked] = "answered";
  else return state;
  const next = nextStep({ ...state, steps: stepsNow }, steps, required);
  return { ...state, steps: stepsNow, asked: next?.index ?? state.asked, lastCall: next?.lastCall ?? false };
}

let counter = 0;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_demo_interview_${Date.now().toString(36)}_${counter++}`, name, input });

/** tool_use ids whose result was an error. */
const failedIds = (messages: Message[]) => new Set(messages.flatMap((m) => blocksOf(m).filter((b) => b.type === "tool_result" && b.is_error).map((b) => String(b.tool_use_id))));

/** Quotes recorded so far in this conversation (tool calls whose result wasn't an error). */
function recorded(messages: Message[]): string[] {
  const failed = failedIds(messages);
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => blocksOf(m).filter((b) => b.type === "tool_use" && b.name === "record_answer" && !failed.has(String(b.id))))
    .map((b) => String((b.input as { quote?: string }).quote ?? ""));
}

const snippet = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim().replace(/[.!?]$/, "");
  if (t.length <= 60) return t;
  const cut = t.slice(0, 60);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 60)}…`;
};

registerFakeGenerator("cvInterview", (req) => {
  const messages = req.body.messages;
  const last = messages.at(-1);
  const conv = info(req);
  const tools = new Set((req.body.tools ?? []).map((t) => String((t as { name?: string }).name)));
  const typed = messages.map(typedText).filter((t): t is string => t !== undefined);
  const said = typed.at(-1) ?? "";
  const ko = conv.language === "ko" || containsHangul(said);
  const family = roleFamily(conv.about?.title || conv.targetTitles?.[0]);
  const steps = plan(conv, ko, family);
  const required = REQUIRED_TOPICS[conv.stage === "current" ? "current" : (conv.role?.depth ?? "deep")];
  const failed = failedIds(messages);

  // Replay the conversation: each typed message moves the plan on; a finished part stays finished
  // until the candidate reopens it.
  let state: State = { steps: steps.map(() => "open"), asked: 0, lastCall: false, finished: false };
  let before = state;
  let latestIndex = -1;
  messages.forEach((m, i) => {
    if (typedText(m) !== undefined) latestIndex = i;
  });
  messages.forEach((m, i) => {
    if (m.role === "assistant") {
      if (blocksOf(m).some((b) => b.type === "tool_use" && b.name === "complete_stage" && !failed.has(String(b.id)))) state = { ...state, finished: true };
      return;
    }
    if (blocksOf(m).some((b) => b.type === "text" && /^<context_update>[\s\S]*reopened this part/.test(String(b.text)))) state = { ...state, finished: false };
    const text = typedText(m);
    if (text === undefined) return;
    if (i === latestIndex) before = state;
    state = apply(state, text, steps, required);
  });

  const thinking = { type: "thinking", thinking: ko ? "답변을 정리하는 중" : "Noting the answer", signature: "" };
  const question = (lead = "") => {
    const step = steps[state.asked];
    const text = state.lastCall
      ? ko
        ? `이 부분에서 마지막으로 필요한 것입니다. ${step.text} 답하시거나 "이 부분은 다 했어요"를 눌러 주세요.`
        : `That's the last thing I need for this part. ${step.text} Answer it, or press "That's all for this part".`
      : step.text;
    const content: Block[] = [{ type: "text", text: `${lead}${text}` }];
    if (!state.lastCall && tools.has("suggest_options") && step.options.length) content.push(toolUse("suggest_options", { options: step.options }));
    return { content };
  };
  const wrap = (reason: "covered" | "candidate_finished") => {
    const list = recorded(messages)
      .map((q) => `- ${q}`)
      .join("\n");
    const text = ko ? `기록한 내용입니다:\n\n${list || "- (없음)"}\n\n고칠 것이 있으면 검토 단계에서 바꿀 수 있습니다.` : `Here's what I recorded:\n\n${list || "- (nothing yet)"}\n\nYou can change any of it in the review step.`;
    return { content: [{ type: "text", text }, toolUse("complete_stage", { summary: ko ? "이 단계를 마쳤습니다." : "This part is covered.", reason })] };
  };
  const askNext = (lead = "") => (nextStep(state, steps, required) === null && state.steps.every((s) => s !== "open") ? wrap("covered") : question(lead));

  // After tools ran.
  const results = last?.role === "user" ? blocksOf(last).filter((b) => b.type === "tool_result") : [];
  if (results.length && !blocksOf(last!).some(isTyped)) {
    const previous = [...messages].reverse().find((m) => m.role === "assistant");
    const uses = previous ? blocksOf(previous).filter((b) => b.type === "tool_use").map((b) => String(b.name)) : [];
    // The question and its examples are out: the turn is over.
    if (uses.length && uses.every((n) => n === "suggest_options")) return { content: [] };
    if (uses.includes("complete_stage")) {
      if (results.some((r) => r.is_error)) return question();
      return { content: [{ type: "text", text: ko ? "감사합니다. 다음 단계로 넘어가세요." : "Thanks, on to the next step." }] };
    }
    if (uses.includes("record_answer")) {
      const errors = results.filter((r) => r.is_error).map((r) => String(r.content));
      if (errors.length) {
        state = before;
        return question(ko ? `기록하지 못했습니다: ${errors.join(" ")} 다시 해 볼게요.\n\n` : `I couldn't record that: ${errors.join(" ")} Let's try again.\n\n`);
      }
      const id = /Recorded #(\d+)/.exec(results.map((r) => String(r.content)).join(" "))?.[1];
      const polished = fakePolish(said);
      if (id && tools.has("propose_polish") && !steps[before.asked]?.private && polished !== said.replace(/\s+/g, " ").trim() && polishGate(said, polished).ok) {
        return { content: [toolUse("propose_polish", { answer_id: Number(id), text: polished })] };
      }
    }
    return askNext(ko ? `"${snippet(said)}" 잘 들었습니다. ` : `You mentioned "${snippet(said)}". `);
  }

  const t = said.trim();
  if (before.finished) {
    return { content: [{ type: "text", text: ko ? "이 부분은 이미 끝났습니다. 계속하기를 누르거나, 더 추가하려면 다시 열기를 누르세요." : "This part is already finished. Press Continue, or Reopen to add more." }] };
  }
  if (CONTROL.finished.test(t)) return wrap("candidate_finished");
  if (CONTROL.skipQuestion.test(t)) return askNext(ko ? "네, 넘어갈게요. " : "Sure, let's move on. ");
  if (CONTROL.noNumber.test(t)) return askNext(ko ? "괜찮습니다. 숫자 없이 기록할게요.\n\n" : "No problem, we'll keep it without a number.\n\n");
  if (!substantial(t)) {
    state = before;
    return question(ko ? "조금 더 자세히 말씀해 주실 수 있나요? 한 문장이면 충분합니다.\n\n" : "Could you say a bit more? Even one sentence helps.\n\n");
  }
  const step = steps[before.asked];
  const skills = SKILLS.filter(([name]) => termPresent(said, name)).map(([name, category]) => toolUse("record_skill", { name, category }));
  return {
    content: [thinking, toolUse("record_answer", { topic: step.topic, quote: said, private: !!step.private, question: step.text }), ...skills],
  };
});
