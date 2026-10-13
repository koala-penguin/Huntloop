"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Building2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { useTask } from "@/components/tasks/use-task";
import { startResearchAction } from "@/app/jobs/[id]/actions";

import { AI_ERROR_CODES } from "@/shared/ai-errors";
function ResearchProgress({ taskId }: { taskId: number }) {
  const t = useTranslations("employer");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const task = useTask(taskId);
  const finished = task && ["succeeded", "failed", "cancelled"].includes(task.status);
  useEffect(() => {
    if (task?.status === "succeeded") router.refresh();
  }, [task?.status, router]);
  const notes = ((task?.progress as { notes?: string[] } | null)?.notes ?? []).slice(-4);
  if (task?.status === "failed") {
    const known = ["refusal", "budget", "invalid_output", "max_tokens", "not_found", ...AI_ERROR_CODES];
    return <Alert tone="danger">{task.errorCode && known.includes(task.errorCode) ? tErrors(task.errorCode) : tErrors("generic", { message: task.errorMessage ?? "" })}</Alert>;
  }
  return (
    <div className="flex flex-col gap-2" role="status" aria-live="polite">
      <p className="flex items-center gap-2 text-sm text-muted">
        {!finished && <Loader2 className="size-4 animate-spin" aria-hidden />}
        {t("researching")}
      </p>
      {notes.length > 0 && (
        <ul className="flex flex-col gap-1 border-l-2 border-border pl-3 text-xs text-muted">
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Start or refresh employer research, and follow its progress. */
export function ResearchControls({ jobId, runningTaskId, hasReport }: { jobId: number; runningTaskId: number | null; hasReport: boolean }) {
  const t = useTranslations("employer");
  const router = useRouter();
  const [taskId, setTaskId] = useState<number | null>(runningTaskId);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (taskId) return <ResearchProgress taskId={taskId} />;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          variant={hasReport ? "secondary" : "primary"}
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await startResearchAction(jobId, hasReport);
              if (!result.ok) setError(result.error);
              else if (result.value.taskId) setTaskId(result.value.taskId);
              else router.refresh();
            })
          }
        >
          {hasReport ? <RefreshCw className="size-3.5" aria-hidden /> : <Building2 className="size-3.5" aria-hidden />}
          {hasReport ? t("refresh") : t("start")}
        </Button>
      </div>
      {!hasReport && <p className="text-xs text-muted">{t("costHint")}</p>}
      {error && <Alert tone="danger">{error === "no_company" ? t("noCompany") : error}</Alert>}
    </div>
  );
}
