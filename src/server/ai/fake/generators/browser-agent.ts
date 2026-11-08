import { registerFakeGenerator, type FakeRequest } from "../transport";

/**
 * Demo-mode browsing agent: a scripted sequence of real browser tool calls (open the start page,
 * snapshot, follow job links, report), so the MCP bridge, guard and lead checks run end to end.
 */

type Block = Record<string, unknown> & { type: string };

function blocks(m: { content: unknown }): Block[] {
  return typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? (m.content as Block[]) : [];
}

function resultText(b: Block): string {
  const c = b.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return (c as Block[]).map((x) => String(x.text ?? "")).join("\n");
  return "";
}

interface Link {
  uid: string;
  name: string;
  url: string;
}

function links(snapshot: string): Link[] {
  return [...snapshot.matchAll(/uid=(\S+) link "((?:[^"\\]|\\.)*)" url="([^"]*)"/g)].map((m) => ({ uid: m[1], name: m[2], url: m[3] }));
}

let counter = 0;
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_demo_browse_${Date.now().toString(36)}_${counter++}`, name, input });

registerFakeGenerator("browserAgent", (req: FakeRequest) => {
  const messages = req.body.messages;
  const task = blocks(messages[0]).map((b) => String(b.text ?? "")).join("\n");
  const find = task.includes("find this exact job");
  const start = (find ? /The employer's website: (\S+?)\.?\s/.exec(task) : /Start at (\S+?)\.?\s*$/m.exec(task))?.[1];
  const title = /"title": "([^"]+)"/.exec(task)?.[1] ?? "";
  const wanted = /up to (\d+)/.exec(task)?.[1];
  const max = Math.min(Number(wanted ?? 2), 2);

  const previous: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
  for (let i = 1; i < messages.length; i += 2) {
    const uses = blocks(messages[i]).filter((b) => b.type === "tool_use");
    const results = messages[i + 1] ? blocks(messages[i + 1]).filter((b) => b.type === "tool_result") : [];
    uses.forEach((u, j) => previous.push({ name: String(u.name), input: (u.input ?? {}) as Record<string, unknown>, result: results[j] ? resultText(results[j]) : "" }));
  }
  const thinking = { type: "thinking", thinking: "Browsing the site", signature: "" };
  const last = previous.at(-1);
  const pageId = Number(/^(\d+):.*\[selected\]\s*$/m.exec([...previous].reverse().find((p) => p.result.includes("[selected]"))?.result ?? "")?.[1] ?? 1);
  const report = (leads: Array<{ url: string; title: string }>) => ({
    content: [thinking, toolUse("report_job_leads", { leads: leads.map((l) => ({ url: l.url, title: l.title, company: null, location: null, country: null, snippet: l.title, postedText: null })) })],
  });

  if (!start) return report([]);
  if (!last) return { content: [thinking, toolUse("new_page", { url: start })] };
  if (last.name !== "take_snapshot") return { content: [thinking, toolUse("take_snapshot", { pageId })] };

  const opened = previous.filter((p) => p.name === "navigate_page").map((p) => String(p.input.url));
  const snapshots = previous.filter((p) => p.name === "take_snapshot");
  if (find) {
    const here = links(last.result);
    const job = here.find((l) => title && l.name.toLowerCase().includes(title.toLowerCase()) && !opened.includes(l.url));
    if (job) return { content: [thinking, toolUse("navigate_page", { pageId, type: "url", url: job.url })] };
    const careers = here.find((l) => /careers|jobs/i.test(l.name));
    if (careers && !previous.some((p) => p.name === "click")) return { content: [thinking, toolUse("click", { pageId, uid: careers.uid })] };
    return report(opened.map((url) => ({ url, title })));
  }
  // Search: open the job links from the first results page, one per step, then report.
  const targets = links(snapshots[0].result)
    .filter((l) => /\/job\/|\/jobs\/\d|\/vacanc|\/position/i.test(l.url) && !/[?&]page=/.test(l.url))
    .filter((l, i, all) => all.findIndex((x) => x.url === l.url) === i)
    .slice(0, max);
  const next = targets.find((t) => !opened.includes(t.url));
  if (next) return { content: [thinking, toolUse("navigate_page", { pageId, type: "url", url: next.url })] };
  return report([...targets, { url: "https://unvisited.example/job/1", name: "Never opened" }].map((t) => ({ url: t.url, title: t.name })));
});
