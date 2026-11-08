"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useTask } from "@/components/tasks/use-task";
import { TaskErrorAlert, taskStopped } from "@/components/tasks/task-error";
import { UserActionPrompt, type TaskUserAction } from "@/components/tasks/user-action-prompt";

const STAGES = ["reading", "transcribing", "analyzing", "assessing", "scoring", "done"] as const;

/**
 * Live progress of a job's background processing; refreshes the page when it finishes. If it fails
 * or is cancelled, says why and shows `retry` (the control that started it), if given.
 */
export function JobProgress({ taskId, retry }: { taskId: number; retry?: ReactNode }) {
  const t = useTranslations("job.stage");
  const router = useRouter();
  const task = useTask(taskId);
  const stage = (task?.progress as { stage?: string } | null)?.stage;
  const finished = task && ["succeeded", "failed", "cancelled"].includes(task.status);

  useEffect(() => {
    if (finished) router.refresh();
  }, [finished, router]);

  if (taskStopped(task)) {
    return (
      <div className="flex flex-col gap-2">
        <TaskErrorAlert task={task} />
        {retry}
      </div>
    );
  }
  const action = (task?.progress as { action?: TaskUserAction } | null)?.action;
  if (task?.status === "needs_user_action" && action) return <UserActionPrompt taskId={taskId} action={action} />;
  const known = STAGES.find((s) => s === stage) ?? "queued";
  return (
    <p className="flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {t(known)}
    </p>
  );
}
