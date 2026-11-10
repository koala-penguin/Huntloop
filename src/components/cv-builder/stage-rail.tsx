"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Check, Circle, CircleDot, SkipForward } from "lucide-react";
import { cn } from "@/lib/cn";
import { goToStageAction } from "@/app/profile/cv-builder/actions";
import { CV_BUILDER_STAGES, type CvBuilderStage, type StageStatus } from "@/shared/schemas/cv-builder";

/** The CV-builder session's steps: done, skipped, current. Any step can be reopened. */
export function StageRail({
  cvBuilderId,
  current,
  statuses,
  answerCount,
  spendToday,
  budgetWarning,
  locked,
}: {
  cvBuilderId: number;
  current: CvBuilderStage;
  statuses: Partial<Record<CvBuilderStage, StageStatus>>;
  answerCount: number;
  spendToday: string;
  budgetWarning: boolean;
  /** A finished CV-builder session stays on the review step. */
  locked: boolean;
}) {
  const t = useTranslations("cvBuilder");
  const router = useRouter();
  const [pending, start] = useTransition();
  const done = CV_BUILDER_STAGES.filter((s) => statuses[s] === "done" || statuses[s] === "skipped").length;
  return (
    <nav aria-label={t("rail.label")} className="flex flex-col gap-3">
      <p className="text-xs text-muted">{t("rail.progress", { done, total: CV_BUILDER_STAGES.length })}</p>
      <ol className="flex flex-col gap-1">
        {CV_BUILDER_STAGES.map((stage) => {
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
                    await goToStageAction(cvBuilderId, stage);
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
