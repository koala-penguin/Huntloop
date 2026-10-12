"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { useTask } from "@/components/tasks/use-task";

const STAGES = ["reading", "transcribing", "analyzing", "assessing", "scoring", "done"] as const;

/** Live progress of a job's background processing; refreshes the page when it finishes. */
export function JobProgress({ taskId }: { taskId: number }) {
  const t = useTranslations("job.stage");
  const router = useRouter();
  const task = useTask(taskId);
  const stage = (task?.progress as { stage?: string } | null)?.stage;
  const finished = task && ["succeeded", "failed", "cancelled"].includes(task.status);

  useEffect(() => {
    if (finished) router.refresh();
  }, [finished, router]);

  const known = STAGES.find((s) => s === stage) ?? "queued";
  return (
    <p className="flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {t(known)}
    </p>
  );
}
