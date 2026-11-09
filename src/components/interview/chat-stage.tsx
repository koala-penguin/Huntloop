"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useTransition } from "react";
import { ArrowRight, Check, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { goToStageAction, skipStageAction } from "@/app/profile/interview/actions";
import type { StageStatus } from "@/shared/schemas/interview";

/** The role tabs above the per-role chat: one conversation per role, each done, skipped or to do. */
export function RoleTabs({ roles, selected }: { roles: Array<{ id: string; label: string; status: StageStatus }>; selected: string }) {
  const t = useTranslations("interview");
  return (
    <nav aria-label={t("roleChat.rolesLabel")} className="flex flex-wrap gap-2">
      {roles.map((r) => (
        <Link
          key={r.id}
          href={`/profile/interview?role=${r.id}`}
          aria-current={r.id === selected ? "page" : undefined}
          className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm", r.id === selected ? "border-accent bg-accent-soft font-medium" : "border-border")}
        >
          {r.label}
          {r.status !== "pending" && <Badge tone="outline">{t(`stageStatus.${r.status}`)}</Badge>}
        </Link>
      ))}
    </nav>
  );
}

/** Keeps the shown role in the address, so a refresh after a turn stays on it (instead of jumping to the next role to do). */
export function PinRole({ id }: { id: string }) {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("role") === id) return;
    url.searchParams.set("role", id);
    window.history.replaceState(null, "", url);
  }, [id]);
  return null;
}

/** Under a chat: done notice, Skip, and Continue (to the next role still to do, or the next step). */
export function ChatStageControls({
  interviewId,
  stage,
  statusKey,
  status,
  nextRole,
  nextStage,
}: {
  interviewId: number;
  stage: "current" | "role_deep";
  /** "current" or "role:exp-N". */
  statusKey: string;
  status: StageStatus;
  nextRole: string | null;
  nextStage: string;
}) {
  const t = useTranslations("interview");
  const router = useRouter();
  const [pending, start] = useTransition();
  // Continue is the user's own "this part is done", whether or not the interviewer wrapped up.
  const next = () =>
    start(async () => {
      if (nextRole) {
        await goToStageAction(interviewId, stage, [statusKey]);
        router.push(`/profile/interview?role=${nextRole}`);
      } else {
        await goToStageAction(interviewId, nextStage, stage === "role_deep" ? [statusKey, stage] : [statusKey]);
        router.push("/profile/interview");
      }
      router.refresh();
    });
  return (
    <div className="flex flex-col gap-2">
      {status === "done" && (
        <Alert tone="neutral" className="flex items-center gap-2">
          <Check className="size-4 shrink-0" aria-hidden />
          {t("roleChat.done")}
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant={status === "done" ? "primary" : "secondary"} disabled={pending} onClick={next}>
          <ArrowRight className="size-3.5" aria-hidden />
          {nextRole ? t("roleChat.nextRole") : t("continue")}
        </Button>
        {status !== "done" && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await skipStageAction(interviewId, statusKey);
                router.push("/profile/interview");
                router.refresh();
              })
            }
          >
            <SkipForward className="size-3.5" aria-hidden />
            {stage === "role_deep" ? t("roleChat.skipRole") : t("skip")}
          </Button>
        )}
      </div>
    </div>
  );
}
