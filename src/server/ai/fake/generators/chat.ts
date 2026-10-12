import { containsHangul, registerFakeGenerator, type FakeRequest } from "../transport";

/**
 * Demo-mode job chat: answers from the fit analysis in the conversation's first message and calls
 * the chat tools on obvious requests, so the whole tool loop runs without an API key.
 */

type Block = Record<string, unknown> & { type: string };

function blocksOf(message: { content: unknown }): Block[] {
  return typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** The candidate's own words in the latest user message (context updates and tool results left out). */
function lastCandidateText(req: FakeRequest): string {
  for (let i = req.body.messages.length - 1; i >= 0; i--) {
    const m = req.body.messages[i];
    if (m.role !== "user") continue;
    const texts = blocksOf(m)
      .filter((b) => b.type === "text" && !String(b.text).startsWith("<context_update>") && !String(b.text).startsWith("<candidate_profile>") && !String(b.text).startsWith("<fit_analysis>"))
      .map((b) => String(b.text));
    if (texts.length) return texts.at(-1)!;
  }
  return "";
}

interface FitSummary {
  job?: { title?: string; company?: string | null };
  interviewChance?: { tier: string; eligibility: string } | null;
  requirements?: Array<{ id: string; postingQuote: string; status: string | null; kind: string }>;
  strengths?: string[];
}

function fitSummary(req: FakeRequest): FitSummary | null {
  const first = req.body.messages[0];
  if (!first) return null;
  const text = blocksOf(first)
    .filter((b) => b.type === "text")
    .map((b) => String(b.text))
    .join("\n");
  const m = /<fit_analysis>\n([\s\S]*?)\n<\/fit_analysis>/.exec(text);
  try {
    return m ? (JSON.parse(m[1]) as FitSummary) : null;
  } catch {
    return null;
  }
}

let toolCounter = 0;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_demo_${Date.now().toString(36)}_${toolCounter++}`, name, input });

const TIER_KO: Record<string, string> = { strong: "높음", good: "좋음", stretch: "도전", long_shot: "낮음" };

registerFakeGenerator("chat", (req) => {
  const messages = req.body.messages;
  const last = messages.at(-1);
  const ko = containsHangul(lastCandidateText(req));
  const thinking = { type: "thinking", thinking: ko ? "적합도 분석을 확인하는 중" : "Checking the fit analysis", signature: "" };

  // After client tools ran: acknowledge.
  const results = last ? blocksOf(last).filter((b) => b.type === "tool_result") : [];
  if (last?.role === "user" && results.length && !lastCandidateText({ ...req, body: { ...req.body, messages: [last] } })) {
    const failed = results.some((r) => r.is_error);
    const text = failed
      ? ko
        ? "그 작업은 지금 할 수 없었습니다. 다른 방법으로 도와드릴게요."
        : "I couldn't do that right now — let's keep going another way."
      : ko
        ? "완료했습니다. 카드가 표시되면 확인해 주세요."
        : "Done. If a card appeared, confirm it when you're ready.";
    return { content: [{ type: "text", text }] };
  }

  const said = lastCandidateText(req);
  if (/\b(note|remember)\b|메모|기억해/i.test(said)) {
    return { content: [thinking, { type: "text", text: ko ? "메모해 둘게요." : "I'll note that." }, toolUse("save_job_note", { note: said.slice(0, 300) })] };
  }
  if (/\bi (have|had|used|built|ran|led|worked)\b|\bi've\b|경험이 있|해봤|써봤/i.test(said)) {
    return {
      content: [
        thinking,
        { type: "text", text: ko ? "좋습니다. 이 내용을 프로필에 추가할지 확인해 주세요." : "That helps. Confirm whether to add this to your profile." },
        toolUse("propose_profile_fact", { fact: said.slice(0, 300), why: ko ? "공고 요구사항과 관련 있습니다." : "It speaks to one of this job's requirements." }),
      ],
    };
  }
  if (/\b(apply|proceed|go for it)\b|지원하|진행하/i.test(said)) {
    return {
      content: [
        thinking,
        { type: "text", text: ko ? "지원할 만한 공고라고 생각합니다. 진행할지 확인해 주세요." : "I think this one is worth applying for. Confirm to go ahead." },
        toolUse("propose_proceed", { recommendation: ko ? "핵심 요구사항 대부분을 충족합니다." : "You meet most of the core requirements.", concerns: [] }),
      ],
    };
  }
  if (/\b(research|employer|company)\b|회사|기업/i.test(said)) {
    return { content: [thinking, { type: "text", text: ko ? "회사 조사를 시작할게요." : "I'll start researching the employer." }, toolUse("start_company_research", {})] };
  }

  const fit = fitSummary(req);
  if (!fit) {
    const text = ko
      ? "데모 모드입니다. `.env.local`에 `ANTHROPIC_API_KEY`를 추가하면 Claude가 실제로 답변합니다."
      : "This is demo mode. Add `ANTHROPIC_API_KEY` to `.env.local` and Claude will answer for real.";
    return { content: [{ type: "text", text }] };
  }
  const title = fit?.job?.title ?? (ko ? "이 공고" : "this job");
  const tier = fit?.interviewChance?.tier;
  const met = fit?.requirements?.filter((r) => r.status === "met") ?? [];
  const open = fit?.requirements?.filter((r) => r.status && r.status !== "met") ?? [];
  const lines = ko
    ? [
        `**${title}** 공고에 대한 데모 답변입니다.`,
        tier ? `- 인터뷰 가능성: **${TIER_KO[tier] ?? tier}**` : "- 아직 인터뷰 가능성을 계산하지 않았습니다.",
        `- 충족한 요구사항: ${met.length}개`,
        open.length ? `- 확인이 필요한 요구사항: ${open.map((r) => `“${r.postingQuote}”`).slice(0, 3).join(", ")}` : "- 확인이 필요한 요구사항이 없습니다.",
        "",
        "`.env.local`에 `ANTHROPIC_API_KEY`를 추가하면 Claude가 실제로 답변합니다.",
      ]
    : [
        `Here's a demo answer about **${title}**.`,
        tier ? `- Interview Chance: **${tier.replace("_", " ")}**` : "- Interview Chance hasn't been worked out yet.",
        `- Requirements you meet: ${met.length}`,
        open.length ? `- Worth checking: ${open.map((r) => `“${r.postingQuote}”`).slice(0, 3).join(", ")}` : "- Nothing left to check.",
        "",
        "Add `ANTHROPIC_API_KEY` to `.env.local` and Claude will answer for real.",
      ];
  return { content: [thinking, { type: "text", text: lines.join("\n") }] };
});
