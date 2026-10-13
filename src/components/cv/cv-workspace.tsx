"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, Download, FileText, Loader2, RefreshCw, Rocket, Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/form";
import { useTask } from "@/components/tasks/use-task";
import { answerCvQuestionAction, proceedAction, reviseCvAction, tailorCvAction } from "@/app/cv/actions";
import type { CvChecks, TailoringPlan } from "@/shared/schemas/cv";
import { FlagCard, type FlaggedLine } from "./flag-card";

import { AI_ERROR_CODES } from "@/shared/ai-errors";
const KNOWN_ERRORS = ["not_found", "no_profile", "not_analyzed", "refusal", "budget", "invalid_output", "max_tokens", "invalid", ...AI_ERROR_CODES];

function ErrorAlert({ code, message }: { code: string | null; message?: string | null }) {
  const tErrors = useTranslations("errors");
  return <Alert tone="danger">{code && KNOWN_ERRORS.includes(code) ? tErrors(code) : tErrors("generic", { message: message ?? code ?? "" })}</Alert>;
}

/** "Proceed": the user decides to go for this job. */
export function ProceedButton({ jobId, size = "sm" }: { jobId: number; size?: "sm" | "md" }) {
  const t = useTranslations("cv");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          size={size}
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await proceedAction(jobId);
              if (!result.ok) setError(result.error);
              else {
                router.push(`/jobs/${jobId}?tab=cv`);
                router.refresh();
              }
            })
          }
        >
          <Rocket className="size-3.5" aria-hidden />
          {t("proceed")}
        </Button>
      </div>
      {error && <ErrorAlert code={error} />}
    </div>
  );
}

function TailorProgress({ taskId }: { taskId: number }) {
  const t = useTranslations("cv");
  const router = useRouter();
  const task = useTask(taskId);
  useEffect(() => {
    if (task?.status === "succeeded") router.refresh();
  }, [task?.status, router]);
  if (task?.status === "failed") return <ErrorAlert code={task.errorCode} message={task.errorMessage} />;
  const stage = ((task?.progress as { stage?: string } | null)?.stage ?? "queued") as "queued" | "planning" | "writing" | "checking";
  return (
    <p className="flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {t(`stage.${["planning", "writing", "checking"].includes(stage) ? stage : "queued"}`)}
    </p>
  );
}

function TailorButton({ jobId, label, onTask }: { jobId: number; label: string; onTask: (id: number) => void }) {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await tailorCvAction(jobId);
          if (result.ok && result.value.taskId) onTask(result.value.taskId);
        })
      }
    >
      <RefreshCw className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}

function Question({ docId, index, text, answered }: { docId: number; index: number; text: string; answered: boolean }) {
  const t = useTranslations("cv");
  const router = useRouter();
  const [answer, setAnswer] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <li className="flex flex-col gap-2">
      <p className="text-sm">{text}</p>
      {answered ? (
        <p className="flex items-center gap-1 text-xs text-muted">
          <CheckCircle2 className="size-3.5" aria-hidden />
          {t("answerSaved")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea aria-label={t("answerLabel", { question: text })} placeholder={t("answerPlaceholder")} rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={1000} />
          <div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending || answer.trim().length < 3}
              onClick={() =>
                start(async () => {
                  const result = await answerCvQuestionAction(docId, index, answer);
                  if (!result.ok) setError(result.error);
                  else router.refresh();
                })
              }
            >
              {t("saveAnswer")}
            </Button>
          </div>
          {error && <ErrorAlert code={error} />}
        </div>
      )}
    </li>
  );
}

function ReviseBox({ docId, onTask }: { docId: number; onTask: (id: number) => void }) {
  const t = useTranslations("cv");
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2">
      <Textarea aria-label={t("reviseLabel")} placeholder={t("revisePlaceholder")} rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} />
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending || text.trim().length < 3}
          onClick={() =>
            start(async () => {
              const result = await reviseCvAction(docId, text);
              if (result.ok && result.value.taskId) {
                setText("");
                onTask(result.value.taskId);
              }
            })
          }
        >
          <Wand2 className="size-3.5" aria-hidden />
          {t("revise")}
        </Button>
      </div>
    </div>
  );
}

const percent = (share: number | null | undefined) => (share === null || share === undefined ? null : Math.round(share * 100));

export interface CvDocView {
  id: number;
  version: number;
  createdAt: string;
  stale: boolean;
  pages: [number, number];
  plan: TailoringPlan | null;
  checks: CvChecks | null;
  blocking: number;
  /** The page estimate is outside what's usual in this market. */
  lengthWarning: boolean;
  flagged: FlaggedLine[];
  answered: number[];
  /** Requirement id → how many lines speak to it. */
  coverage: Array<{ term: string; lines: number }>;
}

export interface CvWorkspaceProps {
  jobId: number;
  proceeded: boolean;
  canTailor: boolean;
  runningTaskId: number | null;
  doc: CvDocView | null;
  versions: Array<{ id: number; version: number }>;
  previewHtml: string | null;
  doNotClaim: string[];
}

/** The job's CV tab: proceed, follow the draft being written, resolve flags, revise, export. */
export function CvWorkspace({ jobId, proceeded, canTailor, runningTaskId, doc, versions, previewHtml, doNotClaim }: CvWorkspaceProps) {
  const t = useTranslations("cv");
  const [taskId, setTaskId] = useState<number | null>(runningTaskId);

  if (!doc) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("emptyTitle")}</CardTitle>
          <CardDescription>{t("emptyDescription")}</CardDescription>
        </CardHeader>
        {taskId ? (
          <TailorProgress taskId={taskId} />
        ) : !canTailor ? (
          <p className="text-sm text-muted">{t("needsAssessment")}</p>
        ) : proceeded ? (
          <TailorButton jobId={jobId} label={t("write")} onTask={setTaskId} />
        ) : (
          <ProceedButton jobId={jobId} size="md" />
        )}
      </Card>
    );
  }

  const plan = doc.plan;
  const before = percent(doc.checks?.keywordsBefore?.share);
  const after = percent(doc.checks?.keywordsAfter?.share);
  const download = (format: "docx" | "pdf") => `/api/cv-documents/${doc.id}/export?format=${format}`;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("draftTitle", { version: doc.version })}</CardTitle>
          <CardDescription>{t("draftDescription")}</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          {versions.length > 1 && (
            <nav className="flex flex-wrap items-center gap-2 text-xs" aria-label={t("versions")}>
              <span className="text-muted">{t("versions")}</span>
              {versions.map((v) => (
                <a key={v.id} href={`/jobs/${jobId}?tab=cv&cv=${v.id}`} className={v.id === doc.id ? "font-semibold" : "text-muted underline"} aria-current={v.id === doc.id ? "page" : undefined}>
                  {t("versionLabel", { version: v.version })}
                </a>
              ))}
            </nav>
          )}
          {doc.stale && (
            <Alert className="flex flex-wrap items-center justify-between gap-3">
              {t("stale")}
              {!taskId && <TailorButton jobId={jobId} label={t("tailorAgain")} onTask={setTaskId} />}
            </Alert>
          )}
          {taskId && <TailorProgress taskId={taskId} />}
          {doc.blocking > 0 ? <Alert>{t("blocking", { count: doc.blocking })}</Alert> : <Alert tone="neutral" className="flex items-center gap-2">
              <CheckCircle2 className="size-4 shrink-0" aria-hidden />
              {t("allVerified")}
            </Alert>}
          <div className="flex flex-wrap gap-2">
            {(["docx", "pdf"] as const).map((format) =>
              doc.blocking > 0 ? (
                <Button key={format} type="button" size="sm" disabled>
                  <Download className="size-3.5" aria-hidden />
                  {t(`download.${format}`)}
                </Button>
              ) : (
                <Button key={format} asChild size="sm" variant={format === "docx" ? "primary" : "secondary"}>
                  <a href={download(format)} download>
                    <Download className="size-3.5" aria-hidden />
                    {t(`download.${format}`)}
                  </a>
                </Button>
              ),
            )}
          </div>
          <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {before !== null && after !== null && (
              <div>
                <dt className="text-xs text-muted">{t("atsTitle")}</dt>
                <dd>{t("atsValue", { before, after })}</dd>
              </div>
            )}
            {doc.checks?.pageEstimate !== null && doc.checks?.pageEstimate !== undefined && (
              <div>
                <dt className="text-xs text-muted">{t("lengthTitle")}</dt>
                <dd className={doc.lengthWarning ? "text-warning" : undefined}>{t("lengthValue", { pages: doc.checks.pageEstimate, min: doc.pages[0], max: doc.pages[1] })}</dd>
              </div>
            )}
          </dl>
          {doc.checks?.languageFallback && <p className="text-xs text-muted">{t("languageFallback")}</p>}
        </div>
      </Card>

      {doc.flagged.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("checkTitle")}</CardTitle>
            <CardDescription>{t("checkDescription")}</CardDescription>
          </CardHeader>
          <ul className="flex flex-col gap-3">
            {doc.flagged.map((line) => (
              <FlagCard key={`${line.id}:${line.text}`} docId={doc.id} line={line} />
            ))}
          </ul>
        </Card>
      )}

      {previewHtml && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="size-4" aria-hidden />
              {t("previewTitle")}
            </CardTitle>
          </CardHeader>
          <iframe title={t("previewTitle")} sandbox="" srcDoc={previewHtml} className="h-[60rem] w-full rounded-md border border-border bg-white" />
        </Card>
      )}

      {plan && (
        <Card>
          <CardHeader>
            <CardTitle>{t("planTitle")}</CardTitle>
            <CardDescription>{plan.summaryAngle}</CardDescription>
          </CardHeader>
          <div className="flex flex-col gap-4 text-sm">
            {doc.coverage.length > 0 && (
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted">{t("targets")}</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {doc.coverage.map((c) => (
                    <li key={c.term}>
                      <Badge tone={c.lines ? "outline" : "neutral"}>{t("targetLines", { term: c.term, count: c.lines })}</Badge>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {doNotClaim.length > 0 && (
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted">{t("doNotClaim")}</h3>
                <p>{doNotClaim.join(", ")}</p>
              </section>
            )}
            {plan.questions.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted">{t("questions")}</h3>
                <ul className="flex flex-col gap-3">
                  {plan.questions.map((q, i) => (
                    <Question key={i} docId={doc.id} index={i} text={q.text} answered={doc.answered.includes(i)} />
                  ))}
                </ul>
              </section>
            )}
            {plan.advice.length > 0 && (
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted">{t("advice")}</h3>
                <ul className="list-disc pl-5">
                  {plan.advice.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </section>
            )}
            {plan.linkedinEmphasis.length > 0 && (
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium text-muted">{t("linkedinPoints")}</h3>
                <ul className="list-disc pl-5">
                  {plan.linkedinEmphasis.map((p, i) => (
                    <li key={i}>
                      <span className="text-muted">{t(`linkedinSection.${p.section}`)}: </span>
                      {p.text}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t("reviseTitle")}</CardTitle>
          <CardDescription>{t("reviseDescription")}</CardDescription>
        </CardHeader>
        <ReviseBox docId={doc.id} onTask={setTaskId} />
      </Card>
    </div>
  );
}
