"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Check, Globe, Loader2, NotebookPen, RotateCcw, Search, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/form";
import { Alert, Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { newConversationAction, resolveChatActionAction } from "@/app/jobs/[id]/actions";
import { newCoachConversationAction } from "@/app/coach/actions";

import { AI_ERROR_CODES } from "@/shared/ai-errors";
export interface ChatItem {
  id: number;
  role: "user" | "assistant";
  text: string;
  activities: Array<{ name: string; detail: string | null }>;
  sources: Array<{ url: string; title: string | null }>;
  actions: Array<{ id: number; kind: string; status: string; payload: Record<string, unknown> }>;
}

interface Live {
  user: string;
  text: string;
  progress: string | null;
  activities: Array<{ name: string; detail: string | null }>;
  /** Items in the transcript when this message was sent; the live view hides once the saved turn shows. */
  baseCount: number;
  finished: boolean;
}

const KNOWN_ERRORS = ["refusal", "budget", "max_tokens", "chat_busy", "job_not_ready", "api", ...AI_ERROR_CODES];
const SUGGESTIONS = ["explain", "fit", "improve", "research"] as const;
const COACH_SUGGESTIONS = ["week", "compare", "followUp", "search"] as const;
const KNOWN_ACTIVITIES = ["web_search", "web_fetch", "save_job_note", "set_job_status", "start_company_research", "revise_cv_draft", "list_jobs", "get_job", "compare_jobs", "search_jobs", "import_job_url"];

/** A job's own chat, or the coach across all jobs. */
export type ChatScopeProp = { kind: "job"; jobId: number } | { kind: "coach" };

function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat text-sm leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="underline">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Activity({ name, detail }: { name: string; detail: string | null }) {
  const t = useTranslations("chat.activity");
  const Icon = name === "web_search" ? Search : name === "web_fetch" ? Globe : name === "save_job_note" ? NotebookPen : Sparkles;
  const known = KNOWN_ACTIVITIES.includes(name);
  return (
    <li className="flex items-center gap-1.5 text-xs text-muted">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">{known ? t(name, { detail: detail ?? "" }) : name}</span>
    </li>
  );
}

function ActionCard({ action }: { action: ChatItem["actions"][number] }) {
  const t = useTranslations("chat.card");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const decide = (decision: "accept" | "dismiss") =>
    start(async () => {
      const result = await resolveChatActionAction(action.id, decision);
      if (!result.ok) setError(result.error);
      router.refresh();
    });
  const fact = action.kind === "profile_fact";
  const concerns = (action.payload.concerns as string[] | undefined) ?? [];
  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent-soft p-3" data-action={action.kind} data-status={action.status}>
      <p className="text-sm font-medium">{fact ? t("factTitle") : t("proceedTitle")}</p>
      <p className="text-sm">{fact ? `“${String(action.payload.fact)}”` : String(action.payload.recommendation ?? "")}</p>
      {fact && action.payload.why ? <p className="text-xs text-muted">{String(action.payload.why)}</p> : null}
      {!fact && concerns.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-muted">
          {concerns.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {action.status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" disabled={pending} onClick={() => decide("accept")}>
            <Check className="size-3.5" aria-hidden />
            {fact ? t("addFact") : t("proceed")}
          </Button>
          <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => decide("dismiss")}>
            <X className="size-3.5" aria-hidden />
            {t("notNow")}
          </Button>
        </div>
      ) : (
        <Badge tone={action.status === "accepted" ? "accent" : "outline"} className="self-start">
          {action.status === "accepted" ? (fact ? t("factAdded") : t("proceeded")) : t("dismissed")}
        </Badge>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

function AssistantBubble({ item }: { item: Pick<ChatItem, "text" | "activities" | "sources" | "actions"> }) {
  const t = useTranslations("chat");
  return (
    <div className="flex flex-col gap-2" data-role="assistant">
      {item.activities.length > 0 && (
        <ul className="flex flex-col gap-1">
          {item.activities.map((a, i) => (
            <Activity key={i} {...a} />
          ))}
        </ul>
      )}
      {item.text && <Markdown text={item.text} />}
      {item.sources.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{t("sources", { count: item.sources.length })}</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {item.sources.map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer" className="underline">
                  {s.title ?? s.url}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
      {item.actions.map((a) => (
        <ActionCard key={a.id} action={a} />
      ))}
    </div>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <div className="max-w-[85%] self-end rounded-lg bg-accent px-3 py-2 text-sm whitespace-pre-wrap text-accent-foreground" data-role="user">
      {text}
    </div>
  );
}

/** A conversation with Claude (one job's, or the coach's): streamed replies, tool activity and confirmation cards. */
export function ChatPanel({ scope, items, hasConversation }: { scope: ChatScopeProp; items: ChatItem[]; hasConversation: boolean }) {
  const t = useTranslations("chat");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const [input, setInput] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, startReset] = useTransition();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const inputId = scope.kind === "job" ? `chat-${scope.jobId}` : "chat-coach";
  const showLive = live && (!live.finished || items.length <= live.baseCount);
  const sending = !!live && !live.finished;

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || sending) return;
    setError(null);
    setInput("");
    setLive({ user: message, text: "", progress: null, activities: [], baseCount: items.length, finished: false });
    let failed: string | null = null;
    try {
      const res = await fetch(scope.kind === "job" ? `/api/jobs/${scope.jobId}/chat` : "/api/coach/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: message }) });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        failed = body.error ?? "api";
      } else {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const line = part.split("\n").find((l) => l.startsWith("data: "));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)) as { type: string; delta?: string; text?: string; name?: string; detail?: string | null; code?: string };
            if (event.type === "text") setLive((l) => l && { ...l, text: l.text + event.delta, progress: null });
            else if (event.type === "progress") setLive((l) => l && { ...l, progress: event.text ?? null });
            else if (event.type === "tool") setLive((l) => l && { ...l, activities: [...l.activities, { name: event.name ?? "", detail: event.detail ?? null }] });
            else if (event.type === "error" && event.code !== "max_tokens") failed = event.code ?? "api";
          }
        }
      }
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
    }
    if (failed) {
      setLive(null);
      setInput(message);
      setError(KNOWN_ERRORS.includes(failed) ? t(`error.${failed}`) : tErrors("generic", { message: failed }));
      return;
    }
    setLive((l) => l && { ...l, finished: true, progress: null });
    router.refresh();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-4" aria-live="polite">
        {items.length === 0 && !showLive && <p className="text-sm text-muted">{scope.kind === "job" ? t("intro") : t("coach.intro")}</p>}
        {items.map((item) => (item.role === "user" ? <UserBubble key={item.id} text={item.text} /> : <AssistantBubble key={item.id} item={item} />))}
        {showLive && (
          <>
            <UserBubble text={live.user} />
            <div className="flex flex-col gap-2">
              <AssistantBubble item={{ text: live.text, activities: live.activities, sources: [], actions: [] }} />
              {!live.finished && (
                <p className="flex items-center gap-2 text-xs text-muted" role="status">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  <span className="line-clamp-1">{live.progress ?? t("thinking")}</span>
                </p>
              )}
            </div>
          </>
        )}
      </div>

      {items.length === 0 && !live && (
        <div className="flex flex-wrap gap-2">
          {(scope.kind === "job" ? SUGGESTIONS.map((s) => t(`suggestion.${s}`)) : COACH_SUGGESTIONS.map((s) => t(`coach.suggestion.${s}`))).map((text) => (
            <Button key={text} type="button" variant="secondary" size="sm" onClick={() => void send(text)}>
              {text}
            </Button>
          ))}
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId} className="sr-only">
          {t("inputLabel")}
        </Label>
        <Textarea
          id={inputId}
          ref={inputRef}
          rows={3}
          value={input}
          disabled={sending}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={scope.kind === "job" ? t("placeholder") : t("coach.placeholder")}
        />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted">{scope.kind === "job" ? t("hint") : t("coach.hint")}</span>
          <div className="flex gap-2">
            {hasConversation && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={sending || resetting}
                onClick={() =>
                  startReset(async () => {
                    await (scope.kind === "job" ? newConversationAction(scope.jobId) : newCoachConversationAction());
                    // The last streamed reply belongs to the old conversation.
                    setLive(null);
                    setError(null);
                    router.refresh();
                  })
                }
              >
                <RotateCcw className="size-3.5" aria-hidden />
                {t("newConversation")}
              </Button>
            )}
            <Button type="button" size="sm" disabled={sending || !input.trim()} onClick={() => void send(input)} className={cn(sending && "opacity-70")}>
              {sending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
              {t("send")}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
