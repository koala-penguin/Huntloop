"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Building2, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { useTask, type TaskState } from "@/components/tasks/use-task";
import { useJobTask } from "@/components/tasks/use-job-task";
import { TaskErrorAlert, taskStopped } from "@/components/tasks/task-error";
import { startResearchAction } from "@/app/jobs/[id]/actions";

import type { Connection } from "@/shared/ai-settings";
import type { TaskRef } from "@/shared/job-tasks";
function ResearchProgress({ task }: { task: TaskState | null }) {
  const t = useTranslations("employer");
  const router = useRouter();
  const finished = task?.status === "succeeded";
  useEffect(() => {
    if (finished) router.refresh();
  }, [finished, router]);
  const notes = ((task?.progress as { notes?: string[] } | null)?.notes ?? []).slice(-4);
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
export function ResearchControls({ jobId, task, hasReport, connection }: { jobId: number; task: TaskRef; hasReport: boolean; connection: Connection }) {
  const t = useTranslations("employer");
  const router = useRouter();
  const [taskId, setTaskId] = useJobTask(jobId, "research", task);
  const followed = useTask(taskId);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // Research that stopped without a report shows why, with the button to try again.
  if (taskId && !taskStopped(followed)) return <ResearchProgress task={followed} />;
  return (
    <div className="flex flex-col gap-2">
      {taskStopped(followed) && <TaskErrorAlert task={followed} />}
      <div>
        <Button
          type="button"
          variant={hasReport ? "secondary" : "primary"}
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
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
      {!hasReport && <p className="text-xs text-muted">{t(`costHint.${connection}`)}</p>}
      {error && <Alert tone="danger">{error === "no_company" ? t("noCompany") : error}</Alert>}
    </div>
  );
}
