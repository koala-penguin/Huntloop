"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, Download, FileText, Loader2, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DemoOutputBadge } from "@/components/ui/demo-output-badge";
import { FlagCard } from "@/components/cv/flag-card";
import type { CvDocView } from "@/components/cv/cv-workspace";
import { useTask } from "@/components/tasks/use-task";
import { TaskErrorAlert, taskStopped } from "@/components/tasks/task-error";
import { discardCvBuilderAction, generateBaseCvAction } from "@/app/profile/cv-builder/actions";

const KNOWN_ERRORS = ["cv_builder_too_short", "task_running", "not_found", "budget", "chat_busy"];

/** Review → Generate: readiness, the build task, then the base CV with its flags, preview and downloads. */
export function GenerateCard({
  cvBuilderId,
  missing,
  hasProfile,
  completed,
  runningTaskId,
  base,
}: {
  cvBuilderId: number;
  /** Stages still needed before generating (empty = ready). */
  missing: string[];
  /** A profile exists and will be replaced (the old version stays in history). */
  hasProfile: boolean;
  completed: boolean;
  runningTaskId: number | null;
  base: { doc: CvDocView; previewHtml: string } | null;
}) {
  const t = useTranslations("cvBuilder");
  const tCv = useTranslations("cv");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const [taskId, setTaskId] = useState<number | null>(runningTaskId);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const task = useTask(taskId);
  const running = taskId !== null && !taskStopped(task) && task?.status !== "succeeded";

  useEffect(() => {
    if (task?.status === "succeeded") router.refresh();
  }, [task?.status, router]);

  const generate = () =>
    start(async () => {
      setError(null);
      setConfirming(false);
      const result = await generateBaseCvAction(cvBuilderId);
      if (!result.ok) setError(result.error);
      else setTaskId(result.value.taskId);
    });
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const result = await fn();
      if (!result.ok) setError(result.error ?? "invalid");
      else router.refresh();
    });
  const doc = base?.doc ?? null;
  const stage = ((task?.progress as { stage?: string } | null)?.stage ?? "queued") as string;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("generate.title")}</CardTitle>
          <CardDescription>{t("generate.description")}</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          {missing.length > 0 && (
            <Alert>
              {t("generate.missing", { stages: missing.map((m) => t(`missing.${m}`)).join(", ") })}
            </Alert>
          )}
          {running ? (
            <p className="flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              {t(`generate.stage.${["building", "writing", "checking"].includes(stage) ? stage : "queued"}`)}
            </p>
          ) : confirming ? (
            <div className="flex flex-col gap-2 rounded-md border border-warning/50 bg-warning-soft p-3">
              <p className="text-sm">{t("generate.replaceWarning")}</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" disabled={pending} onClick={generate}>
                  {t("generate.replace")}
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  {t("drawer.cancel")}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <Button type="button" disabled={pending || missing.length > 0} onClick={() => (hasProfile ? setConfirming(true) : generate())}>
                <Sparkles className="size-4" aria-hidden />
                {doc ? t("generate.again") : t("generate.button")}
              </Button>
            </div>
          )}
          {task && taskStopped(task) && <TaskErrorAlert task={task} />}
          {error && <Alert tone="danger">{KNOWN_ERRORS.includes(error) ? tErrors(error) : tErrors("generic", { message: error })}</Alert>}
        </div>
      </Card>

      {doc && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t("generate.baseTitle", { version: doc.version })} <DemoOutputBadge simulated={doc.simulated} />
              </CardTitle>
              <CardDescription>{t("generate.baseDescription")}</CardDescription>
            </CardHeader>
            <div className="flex flex-col gap-3">
              {doc.stale && <Alert>{t("generate.stale")}</Alert>}
              {doc.blocking > 0 ? (
                <Alert>{tCv("blocking", { count: doc.blocking })}</Alert>
              ) : (
                <Alert tone="neutral" className="flex items-center gap-2">
                  <CheckCircle2 className="size-4 shrink-0" aria-hidden />
                  {t("generate.allVerified")}
                </Alert>
              )}
              <div className="flex flex-wrap gap-2">
                {(["docx", "pdf"] as const).map((format) =>
                  doc.blocking > 0 ? (
                    <Button key={format} type="button" size="sm" disabled>
                      <Download className="size-3.5" aria-hidden />
                      {tCv(`download.${format}`)}
                    </Button>
                  ) : (
                    <Button key={format} asChild size="sm" variant={format === "docx" ? "primary" : "secondary"}>
                      <a href={`/api/cv-documents/${doc.id}/export?format=${format}`} download>
                        <Download className="size-3.5" aria-hidden />
                        {tCv(`download.${format}`)}
                      </a>
                    </Button>
                  ),
                )}
                <Button asChild size="sm" variant="ghost">
                  <Link href="/profile?tab=linkedin">{t("generate.linkedin")}</Link>
                </Button>
              </div>
              {doc.checks?.pageEstimate !== null && doc.checks?.pageEstimate !== undefined && (
                <p className={doc.lengthWarning ? "text-sm text-warning" : "text-sm"}>{tCv("lengthValue", { pages: doc.checks.pageEstimate, min: doc.pages[0], max: doc.pages[1] })}</p>
              )}
            </div>
          </Card>
          {doc.flagged.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>{tCv("checkTitle")}</CardTitle>
                <CardDescription>{t("generate.checkDescription")}</CardDescription>
              </CardHeader>
              <ul className="flex flex-col gap-3">
                {doc.flagged.map((line) => (
                  <FlagCard key={`${line.id}:${line.text}`} docId={doc.id} line={line} />
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="size-4" aria-hidden />
                {tCv("previewTitle")}
              </CardTitle>
            </CardHeader>
            <iframe title={tCv("previewTitle")} sandbox="" srcDoc={base!.previewHtml} className="h-[60rem] w-full rounded-md border border-border bg-white" />
          </Card>
        </>
      )}

      <div className="flex flex-wrap gap-2">
        {completed && (
          <Button asChild size="sm" variant="secondary">
            <Link href="/profile/cv-builder?new=1">{t("generate.startNew")}</Link>
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            if (window.confirm(t("discardConfirm"))) act(() => discardCvBuilderAction(cvBuilderId));
          }}
        >
          <Trash2 className="size-3.5" aria-hidden />
          {t("discard")}
        </Button>
      </div>
    </div>
  );
}
