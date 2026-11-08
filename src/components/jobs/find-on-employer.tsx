"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Building2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { useTask } from "@/components/tasks/use-task";
import { useJobTask } from "@/components/tasks/use-job-task";
import { TaskErrorAlert, taskStopped } from "@/components/tasks/task-error";
import type { TaskRef } from "@/shared/job-tasks";
import { UserActionPrompt, type TaskUserAction } from "@/components/tasks/user-action-prompt";
import { useProgressNoteText } from "@/components/tasks/progress-note";
import type { ProgressNoteLike } from "@/shared/progress-note";
import { findOnEmployerSiteAction } from "@/app/jobs/[id]/actions";

import { AI_ERROR_CODES } from "@/shared/ai-errors";
const KNOWN_ERRORS = ["agent_disabled", "no_company", "budget", "refusal", "browser_unavailable", ...AI_ERROR_CODES];

/** "Find on the employer's site": the browsing agent looks for the employer's own posting. */
export function FindOnEmployerSite({ jobId, task: known, enabled }: { jobId: number; task: TaskRef; enabled: boolean }) {
  const t = useTranslations("job.findOnEmployer");
  const tErrors = useTranslations("errors");
  const noteText = useProgressNoteText();
  const router = useRouter();
  const [taskId, setTaskId] = useJobTask(jobId, "findEmployer", known, { showLast: true });
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const task = useTask(taskId);
  const result = task?.status === "succeeded" ? (task.result as { found: boolean; url: string | null } | null) : null;

  // A search the page didn't render with found the posting: reload the job with it.
  const newerThanPage = taskId !== known.latest;
  useEffect(() => {
    if (result?.found && newerThanPage) router.refresh();
  }, [result?.found, newerThanPage, router]);

  if (!enabled)
    return (
      <p className="text-xs text-muted">
        {t("disabled")}{" "}
        <Link href="/settings" className="underline">
          {t("disabledLink")}
        </Link>
      </p>
    );
  const progress = (task?.progress ?? {}) as { notes?: ProgressNoteLike[]; action?: TaskUserAction };
  if (taskId && task?.status === "needs_user_action" && progress.action) return <UserActionPrompt taskId={taskId} action={progress.action} />;
  const running = taskId !== null && (!task || ["queued", "running"].includes(task.status));

  return (
    <div className="flex flex-col gap-2" data-find-employer>
      {running ? (
        <div className="flex flex-col gap-1" role="status" aria-live="polite">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {t("running")}
          </p>
          {(progress.notes?.length ?? 0) > 0 && (
            <ul className="flex flex-col gap-0.5 border-l-2 border-border pl-3 text-xs text-muted">
              {progress.notes!.slice(-3).map((n, i) => (
                <li key={i}>{noteText(n)}</li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await findOnEmployerSiteAction(jobId);
                if (r.ok) setTaskId(r.value.taskId);
                else setError(r.error);
              })
            }
          >
            <Building2 className="size-3.5" aria-hidden />
            {t("button")}
          </Button>
        </div>
      )}
      {result && !result.found && <p className="text-sm text-muted">{t("notFound")}</p>}
      {result?.found && <p className="text-sm text-muted">{t("found")}</p>}
      {error && <Alert tone="danger">{KNOWN_ERRORS.includes(error) ? tErrors(error) : tErrors("generic", { message: error })}</Alert>}
      {taskStopped(task) && <TaskErrorAlert task={task} />}
    </div>
  );
}
