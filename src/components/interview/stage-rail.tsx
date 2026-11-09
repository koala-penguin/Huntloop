"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, Circle, CircleDot, SkipForward } from "lucide-react";
import { cn } from "@/lib/cn";
import { goToStageAction } from "@/app/profile/interview/actions";
import { INTERVIEW_STAGES, type InterviewStage, type StageStatus } from "@/shared/schemas/interview";

/** The interview's steps: done, skipped, current. Any step can be reopened. */
export function StageRail({
  interviewId,
  current,
  statuses,
  answerCount,
  spendToday,
  budgetWarning,
  locked,
}: {
  interviewId: number;
  current: InterviewStage;
  statuses: Partial<Record<InterviewStage, StageStatus>>;
  answerCount: number;
  spendToday: string;
  budgetWarning: boolean;
  /** A finished interview stays on the review step. */
  locked: boolean;
}) {
  const t = useTranslations("interview");
  const router = useRouter();
  const [pending, start] = useTransition();
  const done = INTERVIEW_STAGES.filter((s) => statuses[s] === "done" || statuses[s] === "skipped").length;
  return (
    <nav aria-label={t("rail.label")} className="flex flex-col gap-3">
      <p className="text-xs text-muted">{t("rail.progress", { done, total: INTERVIEW_STAGES.length })}</p>
      <ol className="flex flex-col gap-1">
        {INTERVIEW_STAGES.map((stage) => {
          const status = statuses[stage] ?? "pending";
          const Icon = stage === current ? CircleDot : status === "done" ? Check : status === "skipped" ? SkipForward : Circle;
          return (
            <li key={stage}>
              <button
                type="button"
                disabled={pending || locked || stage === current}
                aria-current={stage === current ? "step" : undefined}
                onClick={() =>
                  start(async () => {
                    await goToStageAction(interviewId, stage);
                    router.refresh();
                  })
                }
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm", stage === current ? "bg-accent-soft font-medium" : "hover:bg-accent-soft/60", status === "skipped" && "text-muted")}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {t(`stage.${stage}`)}
              </button>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted" data-testid="answer-count">
        {t("rail.answers", { count: answerCount })}
      </p>
      <p className={cn("text-xs", budgetWarning ? "text-warning" : "text-muted")}>{t("rail.spend", { amount: spendToday })}</p>
    </nav>
  );
}
