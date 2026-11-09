"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Check, Globe, Loader2, NotebookPen, Pencil, RotateCcw, Search, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Textarea } from "@/components/ui/form";
import { Alert, Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { newConversationAction, resolveChatActionAction } from "@/app/jobs/[id]/actions";
import { newCoachConversationAction } from "@/app/coach/actions";
import { acceptPolishAction } from "@/app/profile/interview/actions";
import type { ChatOpening, StageStatus } from "@/shared/schemas/interview";

import { AI_ERROR_CODES } from "@/shared/ai-errors";
import type { Connection } from "@/shared/ai-settings";
import { useFieldValue } from "@/components/ui/use-field-value";
export interface ChatItem {
  id: number;
  role: "user" | "assistant";
  text: string;
  activities: Array<{ name: string; detail: string | null }>;
  sources: Array<{ url: string; title: string | null }>;
  actions: Array<{ id: number; kind: string; status: string; payload: Record<string, unknown> }>;
  /** Example replies offered under an interview question. */
  suggestions?: string[];
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

const KNOWN_ERRORS = ["refusal", "budget", "max_tokens", "chat_busy", "job_not_ready", "api", "session_expired", ...AI_ERROR_CODES];
const SUGGESTIONS = ["explain", "fit", "improve", "research"] as const;
const COACH_SUGGESTIONS = ["week", "compare", "followUp", "search"] as const;
/** Quick replies under an interview chat: skip one question, finish the part, no number to give. */
const INTERVIEW_CONTROLS = ["skipQuestion", "thatsAll", "noNumber"] as const;
const KNOWN_ACTIVITIES = [
  "web_search",
  "web_fetch",
  "save_job_note",
  "set_job_status",
  "start_company_research",
  "revise_cv_draft",
  "list_jobs",
  "get_job",
  "compare_jobs",
  "search_jobs",
  "import_job_url",
  "record_answer",
  "record_skill",
  "list_answers",
  "complete_stage",
  "suggest_options",
  "propose_polish",
];

/** A job's own chat, the coach across all jobs, or one stage (and role) of the CV builder interview. */
export type ChatScopeProp =
  | { kind: "job"; jobId: number }
  | { kind: "coach" }
  | { kind: "cv_interview"; interviewId: number; stage: "current" | "role_deep"; experienceRef: string | null; opening: ChatOpening; status: StageStatus };

/** What differs per kind of chat: where messages go, the input's id and the texts around it. */
function scopeView(scope: ChatScopeProp, t: (key: string) => string, hasProfile: boolean) {
  switch (scope.kind) {
    case "job":
      return {
        endpoint: `/api/jobs/${scope.jobId}/chat`,
        body: {},
        inputId: `chat-${scope.jobId}`,
        intro: t("intro"),
        placeholder: t("placeholder"),
        hint: t("hint"),
        suggestions: SUGGESTIONS.filter((s) => hasProfile || s === "explain" || s === "research").map((s) => t(`suggestion.${s}`)),
        alwaysSuggest: false,
        canReset: true,
      };
    case "coach":
      return {
        endpoint: "/api/coach/chat",
        body: {},
        inputId: "chat-coach",
        intro: t("coach.intro"),
        placeholder: t("coach.placeholder"),
        hint: t("coach.hint"),
        suggestions: COACH_SUGGESTIONS.map((s) => t(`coach.suggestion.${s}`)),
        alwaysSuggest: false,
        canReset: true,
      };
    case "cv_interview":
      return {
        endpoint: `/api/cv-interview/${scope.interviewId}/chat`,
        body: { stage: scope.stage, experienceRef: scope.experienceRef },
        inputId: `chat-interview-${scope.stage}-${scope.experienceRef ?? "current"}`,
        intro: null,
        placeholder: t("interview.placeholder"),
        hint: t("interview.hint"),
        suggestions: INTERVIEW_CONTROLS.map((s) => t(`interview.control.${s}`)),
        // Hidden once the part is done: there is no question left to skip.
        alwaysSuggest: scope.status !== "done",
        canReset: false,
      };
  }
}

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

/** A cleaner version of an interview answer: the candidate takes it, edits it, or keeps their own words. */
function PolishCard({ action, interviewId }: { action: ChatItem["actions"][number]; interviewId: number | null }) {
  const t = useTranslations("chat.card");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(action.payload.text ?? ""));
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "invalid");
      else setEditing(false);
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent-soft p-3" data-action={action.kind} data-status={action.status}>
      <p className="text-sm font-medium">{t("polishTitle")}</p>
      {editing ? (
        <Textarea aria-label={t("polishEditLabel")} rows={3} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
      ) : (
        <p className="text-sm" data-polish-text>
          {String(action.payload.text ?? "")}
        </p>
      )}
      <p className="text-xs text-muted">
        {t("polishYours")} {String(action.payload.raw ?? "")}
      </p>
      {action.status === "pending" ? (
        <div className="flex flex-wrap gap-2">
          {editing ? (
            <>
              <Button type="button" size="sm" disabled={pending || text.trim().length < 2 || interviewId === null} onClick={() => run(() => acceptPolishAction(interviewId!, action.id, text))}>
                <Check className="size-3.5" aria-hidden />
                {t("polishSaveEdit")}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setEditing(false)}>
                {t("polishCancel")}
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" disabled={pending} onClick={() => run(() => resolveChatActionAction(action.id, "accept"))}>
                <Check className="size-3.5" aria-hidden />
                {t("polishAccept")}
              </Button>
              <Button type="button" variant="secondary" size="sm" disabled={pending || interviewId === null} onClick={() => setEditing(true)}>
                <Pencil className="size-3.5" aria-hidden />
                {t("polishEdit")}
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => run(() => resolveChatActionAction(action.id, "dismiss"))}>
                <X className="size-3.5" aria-hidden />
                {t("polishKeep")}
              </Button>
            </>
          )}
        </div>
      ) : (
        <Badge tone={action.status === "accepted" ? "accent" : "outline"} className="self-start">
          {action.status === "accepted" ? t("polishAccepted") : t("polishKept")}
        </Badge>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

function ActionCard({ action, interviewId }: { action: ChatItem["actions"][number]; interviewId: number | null }) {
  const t = useTranslations("chat.card");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (action.kind === "interview_polish") return <PolishCard action={action} interviewId={interviewId} />;
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

function AssistantBubble({ item, interviewId = null }: { item: Pick<ChatItem, "text" | "activities" | "sources" | "actions">; interviewId?: number | null }) {
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
        <ActionCard key={a.id} action={a} interviewId={interviewId} />
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
export function ChatPanel({
  scope,
  items,
  hasConversation,
  provider,
  activeConnection,
  hasProfile = true,
}: {
  scope: ChatScopeProp;
  items: ChatItem[];
  hasConversation: boolean;
  /** The connection this thread runs on (threads keep the one they started with); null before the first message. */
  provider: Connection | null;
  /** The connection now selected for this kind of chat. */
  activeConnection: Connection;
  /** Without a profile, Claude can't judge fit, so the fit suggestions are left out. */
  hasProfile?: boolean;
}) {
  const t = useTranslations("chat");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const [input, setInput, inputRef] = useFieldValue<HTMLTextAreaElement>();
  const [live, setLive] = useState<Live | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resetting, startReset] = useTransition();

  const view = scopeView(scope, t, hasProfile);
  const inputId = view.inputId;
  const showLive = live && (!live.finished || items.length <= live.baseCount);
  const sending = !!live && !live.finished;
  const interviewId = scope.kind === "cv_interview" ? scope.interviewId : null;
  // Examples under the interviewer's latest question (the opening's before the first message). They
  // only fill the reply box: what the candidate sends is their answer.
  const lastItem = items.at(-1);
  const examples =
    scope.kind !== "cv_interview" || scope.status === "done" || showLive ? [] : items.length === 0 ? scope.opening.options : lastItem?.role === "assistant" ? (lastItem.suggestions ?? []) : [];
  const addExample = (text: string) => {
    setInput((prev) => (prev.trim() ? `${prev.trimEnd()}\n${text}` : text));
    inputRef.current?.focus();
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || sending) return;
    setError(null);
    setInput("");
    setLive({ user: message, text: "", progress: null, activities: [], baseCount: items.length, finished: false });
    let failed: string | null = null;
    try {
      const res = await fetch(view.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...view.body, text: message }) });
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
        {items.length === 0 && !showLive && view.intro && <p className="text-sm text-muted">{view.intro}</p>}
        {scope.kind === "cv_interview" && <AssistantBubble item={{ text: scope.opening.text, activities: [], sources: [], actions: [] }} />}
        {items.map((item) => (item.role === "user" ? <UserBubble key={item.id} text={item.text} /> : <AssistantBubble key={item.id} item={item} interviewId={interviewId} />))}
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

      {examples.length > 0 && !sending && (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted">{t("interview.suggestionsHint")}</p>
          <div role="group" aria-label={t("interview.suggestionsLabel")} className="flex flex-wrap gap-2">
            {examples.map((text) => (
              <Button key={text} type="button" variant="secondary" size="sm" data-suggestion={text} onClick={() => addExample(text)}>
                {text}
              </Button>
            ))}
          </div>
        </div>
      )}

      {(scope.kind === "cv_interview" ? view.alwaysSuggest && !sending : items.length === 0 && !live) && (
        <div className="flex flex-wrap gap-2">
          {view.suggestions.map((text, i) => (
            <Button
              key={text}
              type="button"
              variant={scope.kind === "cv_interview" ? "ghost" : "secondary"}
              size="sm"
              data-control={scope.kind === "cv_interview" ? INTERVIEW_CONTROLS[i] : undefined}
              onClick={() => void send(text)}
            >
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
          placeholder={view.placeholder}
        />
        {hasConversation && provider && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="outline">{t(`runsOn.${provider}`)}</Badge>
            {provider !== activeConnection && <p className="text-xs text-muted">{t(`providerNote.${provider}`)}</p>}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted">{view.hint}</span>
          <div className="flex gap-2">
            {hasConversation && view.canReset && (
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
