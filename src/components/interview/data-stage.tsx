"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ArrowRight, Check, Pencil, RotateCcw, SkipForward, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { completeDataStageAction, reopenStageAction, saveOnFileAction, skipStageAction } from "@/app/profile/interview/actions";
import type { DataChatStage, FormCardStage, FormCardValue, StageStatus } from "@/shared/schemas/interview";
import { FormCardEditor, useSummaryLines, type CardContext } from "./form-card";

/** A requirement code ("roles.1.start") in words: "the start date of role 2". */
export function useNeedLabel() {
  const t = useTranslations("interview.need");
  return (code: string) => {
    const row = /^roles\.(\d+)\.(\w+)$/.exec(code);
    return row ? t(`roles.${row[2]}`, { n: Number(row[1]) + 1 }) : t(code);
  };
}

/**
 * What is saved for a step, under its chat: a short read-back with Edit. The way to correct or
 * remove something, and to fill a step in by hand when the interviewer can't be reached.
 */
export function OnFile({ interviewId, stage, value, context, editable }: { interviewId: number; stage: FormCardStage; value: FormCardValue; context: CardContext; editable: boolean }) {
  const t = useTranslations("interview");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [pending, start] = useTransition();
  const lines = useSummaryLines()(stage, value);
  const save = () =>
    start(async () => {
      const result = await saveOnFileAction(interviewId, stage, draft);
      if (!result.ok) {
        setInvalid(result.fields ?? []);
        setFailed(true);
        return;
      }
      setEditing(false);
      setInvalid([]);
      setFailed(false);
      router.refresh();
    });
  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-3" data-onfile={stage} aria-label={t("onFile.title")}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t("onFile.title")}</h3>
        {editable && !editing && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-10"
            onClick={() => {
              setDraft(value);
              setInvalid([]);
              setFailed(false);
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" aria-hidden />
            {t("onFile.edit")}
          </Button>
        )}
      </div>
      {editing ? (
        <>
          <FormCardEditor
            stage={stage}
            value={draft}
            onChange={(next) => {
              setDraft(next);
              setInvalid([]);
            }}
            flags={{ inferred: [], invalid }}
            context={context}
            full
          />
          {failed && (
            <Alert tone="danger" role="alert">
              {t("invalidForm")}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="h-10" disabled={pending} onClick={save}>
              <Check className="size-3.5" aria-hidden />
              {t("onFile.save")}
            </Button>
            <Button type="button" size="sm" variant="ghost" className="h-10" disabled={pending} onClick={() => setEditing(false)}>
              {t("onFile.cancel")}
            </Button>
          </div>
        </>
      ) : lines.length ? (
        <ul className="flex flex-col gap-1 text-sm">
          {lines.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("onFile.empty")}</p>
      )}
    </section>
  );
}

/** Under a data step's chat: Continue (checked in code), Skip where the step is optional, and the way back. */
export function DataStageControls({ interviewId, stage, status, skippable }: { interviewId: number; stage: DataChatStage; status: StageStatus; skippable: boolean }) {
  const t = useTranslations("interview");
  const tErrors = useTranslations("errors");
  const need = useNeedLabel();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string; fields?: string[] }>) =>
    start(async () => {
      setProblem(null);
      const result = await fn();
      if (result.ok) {
        router.push("/profile/interview");
        router.refresh();
      } else if (result.error === "stage_incomplete") setProblem(t("stillNeeded", { items: (result.fields ?? []).map(need).join(", ") }));
      else if (result.error === "card_pending") setProblem(t("cardPending"));
      else setProblem(tErrors("generic", { message: result.error ?? "" }));
    });
  return (
    <div className="flex flex-col gap-2">
      {status === "done" && (
        <Alert tone="neutral" className="flex items-center gap-2">
          <Check className="size-4 shrink-0" aria-hidden />
          {t("roleChat.done")}
        </Alert>
      )}
      {status === "skipped" && (
        <Alert tone="neutral" className="flex flex-wrap items-center gap-2" data-skipped>
          <SkipForward className="size-4 shrink-0" aria-hidden />
          <span className="flex-1">{t("roleChat.skipped")}</span>
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => reopenStageAction(interviewId, stage))}>
            <Undo2 className="size-3.5" aria-hidden />
            {t("undoSkip")}
          </Button>
        </Alert>
      )}
      {problem && (
        <Alert tone="danger" role="alert">
          {problem}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className="h-10" disabled={pending} onClick={() => run(() => completeDataStageAction(interviewId, stage))}>
          <ArrowRight className="size-3.5" aria-hidden />
          {t("continue")}
        </Button>
        {status === "done" && (
          <Button type="button" size="sm" variant="ghost" className="h-10" disabled={pending} onClick={() => run(() => reopenStageAction(interviewId, stage))}>
            <RotateCcw className="size-3.5" aria-hidden />
            {t("roleChat.reopen")}
          </Button>
        )}
        {skippable && status === "pending" && (
          <Button type="button" size="sm" variant="ghost" className="h-10" disabled={pending} onClick={() => run(() => skipStageAction(interviewId, stage))}>
            <SkipForward className="size-3.5" aria-hidden />
            {t("skip")}
          </Button>
        )}
      </div>
    </div>
  );
}
