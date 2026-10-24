"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Alert } from "@/components/ui/badge";
import { useTask } from "@/components/tasks/use-task";
import { UserActionPrompt, type TaskUserAction } from "@/components/tasks/user-action-prompt";
import { useProgressNoteText } from "@/components/tasks/progress-note";
import type { ProgressNoteLike } from "@/shared/progress-note";

interface Progress {
  stage?: string;
  counts?: { leads: number; unique: number; screened: number; toScreen: number; deep: number; toDeep: number };
  notes?: ProgressNoteLike[];
  action?: TaskUserAction;
}

const STAGES = ["planning", "sourcing", "filtering", "screening", "deep", "done"] as const;

/** Live progress of a search run; refreshes the page when it finishes. Leaving the page is fine. */
export function SearchProgress({ taskId }: { taskId: number }) {
  const t = useTranslations("search.progress");
  const tErrors = useTranslations("errors");
  const noteText = useProgressNoteText();
  const router = useRouter();
  const task = useTask(taskId);
  const done = task && ["succeeded", "failed", "cancelled"].includes(task.status);
  useEffect(() => {
    if (done) router.refresh();
  }, [done, router]);

  if (task?.status === "failed") return <Alert tone="danger">{tErrors("generic", { message: task.errorMessage ?? "" })}</Alert>;
  const progress = (task?.progress ?? {}) as Progress;
  const stage = STAGES.find((s) => s === progress.stage) ?? "planning";
  const c = progress.counts;
  if (task?.status === "needs_user_action" && progress.action) return <UserActionPrompt taskId={taskId} action={progress.action} />;
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t(`stage.${stage}`)}
      </p>
      {c && (
        <p className="text-xs text-muted">
          {stage === "screening"
            ? t("screening", { done: c.screened, total: c.toScreen })
            : stage === "deep"
              ? t("deep", { done: c.deep, total: c.toDeep })
              : t("found", { leads: c.leads, unique: c.unique })}
        </p>
      )}
      {(progress.notes?.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-1 border-l-2 border-border pl-3 text-xs text-muted">
          {progress.notes!.slice(-3).map((n, i) => (
            <li key={i}>{noteText(n)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
