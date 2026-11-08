import { containsHangul, registerFakeGenerator, type FakeRequest } from "../transport";

/**
 * Demo-mode coach: reads the pipeline from the conversation's first message and calls the coach
 * tools on obvious requests (list, compare, search, add a link), so the tool loop runs without a key.
 */

type Block = Record<string, unknown> & { type: string };

const blocksOf = (message: { content: unknown }): Block[] =>
  typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? (message.content as Block[]) : [];

const CONTEXT = /^<(context_update|candidate_profile|job_preferences|pipeline)>/;

function lastCandidateText(messages: FakeRequest["body"]["messages"]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue;
    const texts = blocksOf(messages[i])
      .filter((b) => b.type === "text" && !CONTEXT.test(String(b.text)))
      .map((b) => String(b.text));
    if (texts.length) return texts.at(-1)!;
  }
  return "";
}

interface PipelineJob {
  id: number;
  title: string | null;
  company: string | null;
  status: string;
  tier: string | null;
}

function pipeline(req: FakeRequest): PipelineJob[] {
  const text = blocksOf(req.body.messages[0] ?? { content: [] })
    .map((b) => String(b.text ?? ""))
    .join("\n");
  try {
    return JSON.parse(/<pipeline>\n([\s\S]*?)\n<\/pipeline>/.exec(text)?.[1] ?? "[]") as PipelineJob[];
  } catch {
    return [];
  }
}

let counter = 0;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_demo_coach_${Date.now().toString(36)}_${counter++}`, name, input });
const label = (j: PipelineJob) => `${j.title ?? "Untitled"}${j.company ? ` — ${j.company}` : ""} (#${j.id})`;

registerFakeGenerator("coach", (req) => {
  const messages = req.body.messages;
  const last = messages.at(-1);
  const said = lastCandidateText(messages);
  const ko = containsHangul(said);
  const thinking = { type: "thinking", thinking: ko ? "지원 현황을 살펴보는 중" : "Looking at the pipeline", signature: "" };

  // After a tool ran: turn its result into an answer.
  const results = last?.role === "user" ? blocksOf(last).filter((b) => b.type === "tool_result") : [];
  if (results.length && !blocksOf(last!).some((b) => b.type === "text" && !CONTEXT.test(String(b.text)))) {
    const content = results.map((r) => String(r.content ?? "")).join("\n");
    if (results.some((r) => r.is_error)) return { content: [{ type: "text", text: ko ? `그 작업은 할 수 없었습니다: ${content}` : `I couldn't do that: ${content}` }] };
    const lines = content
      .split("\n")
      .map((l) => {
        try {
          return JSON.parse(l) as PipelineJob;
        } catch {
          return null;
        }
      })
      .filter((j): j is PipelineJob => !!j && typeof j.id === "number");
    const text = lines.length
      ? `${ko ? "현재 공고입니다:" : "Here's where things stand:"}\n\n${lines.map((j) => `- ${label(j)} — ${j.tier ?? "–"}, ${j.status}`).join("\n")}`
      : `${ko ? "완료했습니다." : "Done."} ${content.slice(0, 600)}`;
    return { content: [{ type: "text", text }] };
  }

  const jobs = pipeline(req);
  const url = /https?:\/\/\S+/.exec(said)?.[0];
  if (url) return { content: [thinking, { type: "text", text: ko ? "이 공고를 추가할게요." : "I'll add that job." }, toolUse("import_job_url", { url })] };
  if (/\bcompare\b|비교/i.test(said) && jobs.length >= 2) {
    return { content: [thinking, { type: "text", text: ko ? "두 공고를 비교해 볼게요." : "Let me compare your top two." }, toolUse("compare_jobs", { job_ids: jobs.slice(0, 2).map((j) => j.id) })] };
  }
  if (/\b(search|find|look for)\b|찾아|검색/i.test(said)) {
    return { content: [thinking, { type: "text", text: ko ? "검색을 시작할게요." : "I'll start a search." }, toolUse("search_jobs", { query: said.slice(0, 200) })] };
  }
  if (/\b(pipeline|list|jobs|week|follow)\b|현황|목록|이번 주|후속/i.test(said)) {
    return { content: [thinking, toolUse("list_jobs", { status: "active", tier: "any", limit: 10 })] };
  }
  const best = jobs.filter((j) => j.tier === "strong" || j.tier === "good").slice(0, 3);
  const text = ko
    ? `데모 모드에서는 간단한 규칙으로 답합니다. 진행 중인 공고가 ${jobs.length}개 있습니다.${best.length ? ` 먼저 볼 만한 공고: ${best.map(label).join(", ")}.` : ""}`
    : `In demo mode I answer with simple rules. You have ${jobs.length} active job(s).${best.length ? ` Worth your time first: ${best.map(label).join(", ")}.` : ""}`;
  return { content: [thinking, { type: "text", text }] };
});
