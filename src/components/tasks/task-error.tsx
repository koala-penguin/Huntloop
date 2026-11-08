"use client";

import { useTranslations } from "next-intl";
import { Alert } from "@/components/ui/badge";
import type { TaskState } from "@/components/tasks/use-task";
import { AI_ERROR_CODES } from "@/shared/ai-errors";

const KNOWN_ERRORS: readonly string[] = [
  "not_found",
  "interrupted",
  "no_company",
  "no_profile",
  "not_analyzed",
  "not_a_job_posting",
  "url_blocked",
  "missing_posting",
  "agent_disabled",
  "browser_unavailable",
  "invalid",
  ...AI_ERROR_CODES,
];

/** A task that ended without a result (failed or cancelled). */
export function taskStopped(task: TaskState | null): task is TaskState & { status: "failed" | "cancelled" } {
  return task?.status === "failed" || task?.status === "cancelled";
}

/** Why a background task stopped without a result. */
export function TaskErrorAlert({ task }: { task: TaskState }) {
  const tErrors = useTranslations("errors");
  if (task.status === "cancelled") return <Alert tone="danger">{tErrors("cancelled")}</Alert>;
  return (
    <Alert tone="danger">{task.errorCode && KNOWN_ERRORS.includes(task.errorCode) ? tErrors(task.errorCode) : tErrors("generic", { message: task.errorMessage ?? "" })}</Alert>
  );
}
