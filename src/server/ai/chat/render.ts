import type { ChatActionRow, ChatMessageRow } from "../../db/schema";

/** What the chat UI shows; the stored API content stays untouched. */
export interface TranscriptItem {
  id: number;
  role: "user" | "assistant";
  text: string;
  activities: Array<{ name: string; detail: string | null }>;
  sources: Array<{ url: string; title: string | null }>;
  actions: Array<{ id: number; kind: string; status: string; payload: Record<string, unknown> }>;
}

type Block = Record<string, unknown> & { type: string };

/** User rows become bubbles; consecutive assistant rows (tool loops, pauses) merge into one answer. */
export function transcript(rows: ChatMessageRow[], actions: ChatActionRow[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let current: TranscriptItem | null = null;
  for (const row of rows) {
    if (row.kind === "user") {
      current = null;
      items.push({ id: row.id, role: "user", text: row.text ?? "", activities: [], sources: [], actions: [] });
      continue;
    }
    if (row.kind !== "assistant") continue;
    if (!current) {
      current = { id: row.id, role: "assistant", text: "", activities: [], sources: [], actions: [] };
      items.push(current);
    }
    for (const block of row.content as Block[]) {
      if (block.type === "text") {
        current.text += (current.text && !current.text.endsWith("\n") ? "\n\n" : "") + String(block.text ?? "");
        for (const c of (block.citations as Array<Record<string, unknown>> | null | undefined) ?? []) {
          const url = typeof c.url === "string" ? c.url : null;
          if (url && !current.sources.some((s) => s.url === url)) current.sources.push({ url, title: typeof c.title === "string" ? c.title : null });
        }
      } else if (block.type === "server_tool_use" || block.type === "tool_use") {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const detail = [input.query, input.url, input.note, input.status].find((v) => typeof v === "string") as string | undefined;
        if (!["propose_profile_fact", "propose_proceed"].includes(String(block.name))) current.activities.push({ name: String(block.name), detail: detail ?? null });
      }
    }
    for (const action of actions.filter((a) => a.messageId === row.id)) {
      current.actions.push({ id: action.id, kind: action.kind, status: action.status, payload: action.payload as Record<string, unknown> });
    }
  }
  return items.filter((i) => i.role === "user" || i.text || i.activities.length || i.actions.length);
}
