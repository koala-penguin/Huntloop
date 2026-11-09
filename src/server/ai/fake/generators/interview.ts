import { termPresent } from "../../../scoring/keywords";
import { containsHangul, registerFakeGenerator, type FakeRequest } from "../transport";

/**
 * Demo-mode CV interviewer: a fixed list of questions per stage. Each typed answer is recorded
 * verbatim with record_answer (and known skill names with record_skill); "that's all" or "skip" ends
 * the stage, as does reaching the end of the list (after a read-back). Deterministic, so tests and
 * the e2e suite can drive a whole interview without a key.
 */

type Block = Record<string, unknown> & { type: string };

const blocksOf = (message: { content: unknown }): Block[] =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? (message.content as Block[]) : [];

const CONTEXT = /^<(context_update|interview_form|timeline|this_conversation|recorded_answers|market_notes)>/;
const isTyped = (b: Block) => b.type === "text" && !CONTEXT.test(String(b.text));

export const INTERVIEW_STOP = /^(that'?s all|that is all|done|skip|next|다 했어요|건너뛰기|다음)[.!]?$/i;
export const INTERVIEW_NO_NUMBER = /^(i don'?t have a number|no number|숫자는 없어요|숫자가 없어요)[.!]?$/i;

const QUESTIONS: Record<"current" | "role" | "role_ko" | "current_ko", Array<{ q: string; topic: string; private?: boolean }>> = {
  current: [
    { q: "Describe a normal week in your current (or most recent) role.", topic: "context" },
    { q: "Who do you work with and report to, and who reports to you? Please type any numbers as digits.", topic: "scope" },
    { q: "What are you most proud of in this role so far?", topic: "achievement" },
    { q: "Why are you looking for a new role? This stays private and never goes on your CV.", topic: "context", private: true },
    { q: "What do you want more of, or less of, in your next role? (Private too.)", topic: "other", private: true },
  ],
  current_ko: [
    { q: "현재 하고 있는 일의 평범한 한 주를 설명해 주세요.", topic: "context" },
    { q: "누구와 함께 일하고 누구에게 보고하나요? 나에게 보고하는 사람은 몇 명인가요? 숫자는 숫자로 적어 주세요.", topic: "scope" },
    { q: "이 역할에서 가장 자랑스러운 일은 무엇인가요?", topic: "achievement" },
    { q: "새 일자리를 찾는 이유는 무엇인가요? 이 답은 비공개이며 CV에 들어가지 않습니다.", topic: "context", private: true },
    { q: "다음 직장에서 더 하고 싶은 일, 덜 하고 싶은 일은 무엇인가요? (이것도 비공개입니다.)", topic: "other", private: true },
  ],
  role: [
    { q: "What was the scope of this role — team size, budget, customers or systems? Please type any numbers as digits.", topic: "scope" },
    { q: "What were the main things you were accountable for?", topic: "responsibility" },
    { q: "Tell me about an achievement you're proud of: what did you do, and what changed? Any number helps.", topic: "achievement" },
    { q: "Which tools, technologies or methods did you use most?", topic: "tool" },
  ],
  role_ko: [
    { q: "이 역할의 범위는 어땠나요? 팀 규모, 예산, 고객, 시스템 등 — 숫자는 숫자로 적어 주세요.", topic: "scope" },
    { q: "주로 책임졌던 일은 무엇이었나요?", topic: "responsibility" },
    { q: "자랑스러운 성과를 하나 말해 주세요. 무엇을 했고, 무엇이 달라졌나요? 숫자가 있으면 좋습니다.", topic: "achievement" },
    { q: "가장 많이 쓴 도구, 기술, 방법은 무엇이었나요?", topic: "tool" },
  ],
};

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
  language: string;
}

function info(req: FakeRequest): Info {
  const text = blocksOf(req.body.messages[0] ?? { content: [] })
    .map((b) => String(b.text ?? ""))
    .join("\n");
  try {
    return JSON.parse(/<this_conversation>\n([\s\S]*?)\n<\/this_conversation>/.exec(text)?.[1] ?? "") as Info;
  } catch {
    return { stage: "current", role: null, language: "en" };
  }
}

/** Every text the candidate typed, oldest first. */
function typedTexts(messages: FakeRequest["body"]["messages"]): string[] {
  return messages
    .filter((m) => m.role === "user")
    .map((m) => blocksOf(m).filter(isTyped).map((b) => String(b.text)))
    .filter((t) => t.length)
    .map((t) => t.at(-1)!);
}

/** Quotes recorded so far in this conversation (tool calls whose result wasn't an error). */
function recorded(messages: FakeRequest["body"]["messages"]): string[] {
  const failed = new Set(messages.flatMap((m) => blocksOf(m).filter((b) => b.type === "tool_result" && b.is_error).map((b) => String(b.tool_use_id))));
  return messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => blocksOf(m).filter((b) => b.type === "tool_use" && b.name === "record_answer" && !failed.has(String(b.id))))
    .map((b) => String((b.input as { quote?: string }).quote ?? ""));
}

let counter = 0;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_demo_interview_${Date.now().toString(36)}_${counter++}`, name, input });

registerFakeGenerator("cvInterview", (req) => {
  const messages = req.body.messages;
  const last = messages.at(-1);
  const conv = info(req);
  const typed = typedTexts(messages);
  const said = typed.at(-1) ?? "";
  const ko = conv.language === "ko" || containsHangul(said);
  const script = conv.stage === "current" ? QUESTIONS[ko ? "current_ko" : "current"] : QUESTIONS[ko ? "role_ko" : "role"].slice(0, conv.role?.depth === "brief" ? 2 : 4);
  // The candidate's latest message answers question number `asked` (the first was shown by the app).
  const asked = Math.max(0, typed.length - 1);
  const next = script[asked + 1];
  const thinking = { type: "thinking", thinking: ko ? "답변을 정리하는 중" : "Noting the answer", signature: "" };
  const wrap = () => {
    const quotes = recorded(messages);
    const list = quotes.map((q) => `- ${q}`).join("\n");
    const text = ko ? `기록한 내용입니다:\n\n${list || "- (없음)"}\n\n고칠 것이 있으면 검토 단계에서 바꿀 수 있습니다.` : `Here's what I recorded:\n\n${list || "- (nothing yet)"}\n\nYou can change any of it in the review step.`;
    return { content: [{ type: "text", text }, toolUse("complete_stage", { summary: ko ? "이 단계를 마쳤습니다." : "This part is covered." })] };
  };

  // After tools ran: ask the next question, or wrap up.
  const results = last?.role === "user" ? blocksOf(last).filter((b) => b.type === "tool_result") : [];
  if (results.length && !blocksOf(last!).some(isTyped)) {
    if (results.some((r) => String(r.content).startsWith("This part is marked done"))) {
      return { content: [{ type: "text", text: ko ? "감사합니다. 다음 단계로 넘어가세요." : "Thank you — on to the next step." }] };
    }
    const errors = results.filter((r) => r.is_error).map((r) => String(r.content));
    if (errors.length) return { content: [{ type: "text", text: ko ? `기록하지 못했습니다: ${errors.join(" ")}` : `I couldn't record that: ${errors.join(" ")}` }] };
    if (!next) return wrap();
    return { content: [{ type: "text", text: next.q }] };
  }

  if (INTERVIEW_STOP.test(said.trim())) return wrap();
  if (INTERVIEW_NO_NUMBER.test(said.trim())) {
    return { content: [{ type: "text", text: `${ko ? "괜찮습니다. 숫자 없이 기록할게요." : "No problem — we'll keep it without a number."}${next ? `\n\n${next.q}` : ""}` }] };
  }
  const question = script[asked] ?? script.at(-1)!;
  const skills = SKILLS.filter(([name]) => termPresent(said, name)).map(([name, category]) => toolUse("record_skill", { name, category }));
  return {
    content: [thinking, toolUse("record_answer", { topic: question.topic, quote: said, private: !!question.private, question: question.q }), ...skills],
  };
});
