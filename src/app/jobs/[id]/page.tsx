import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { appContext } from "@/server/context";
import { findDuplicates, getJob, listAttachments } from "@/server/repo/jobs";
import { loadJobFit } from "@/server/jobs/fit";
import { activeJobTask } from "@/server/jobs/intake";
import { applyProse, getCachedTranslation, missingGlosses } from "@/server/jobs/prose";
import { parseTaskError } from "@/server/errors";
import { placeLabel } from "@/shared/countries";
import { Alert, Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SimpleTabs } from "@/components/ui/tabs";
import { PostingInput } from "@/components/jobs/posting-input";
import { JobProgress } from "@/components/jobs/job-progress";
import { FitReport } from "@/components/jobs/fit-report";
import { PostingOverview } from "@/components/jobs/posting-overview";
import { DeleteJobButton, PostingTextEditor, ReassessButton, StatusSelect, TranslateReport } from "@/components/jobs/job-controls";
import { ChatPanel } from "@/components/jobs/chat-panel";
import { getJobConversation, listChatActions, listChatMessages } from "@/server/ai/chat/harness";
import { transcript } from "@/server/ai/chat/render";
import { EmployerReport } from "@/components/jobs/employer-report";
import { ResearchControls } from "@/components/jobs/research-controls";
import { activeResearchTask, getLatestReport } from "@/server/research/company";

const KNOWN_ERRORS = ["not_a_job_posting", "url_blocked", "missing_posting", "refusal", "budget", "invalid_output", "max_tokens"];

export default async function JobPage({ params, searchParams }: PageProps<"/jobs/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  const t = await getTranslations("job");
  const tErrors = await getTranslations("errors");
  const tEnum = await getTranslations("jobEnums");
  const locale = await getLocale();
  const { db, user } = appContext();
  const job = getJob(db, user.id, Number(id));
  if (!job) notFound();
  const conversation = getJobConversation({ db, userId: user.id }, job.id);
  const chatItems = conversation ? transcript(listChatMessages({ db }, conversation.id), listChatActions({ db }, conversation.id)) : [];
  const report = job.companyId ? getLatestReport(db, job.companyId) : null;
  const researchTask = job.companyId ? activeResearchTask(db, user.id, job.companyId) : null;

  const taskId = activeJobTask(db, user.id, job);
  const fit = loadJobFit(db, user.id, job);
  const attachments = listAttachments(db, job.id);
  const duplicates = findDuplicates(db, user.id, job);
  const error = parseTaskError(job.intakeError);
  const errorText = error.code && KNOWN_ERRORS.includes(error.code) ? tErrors(error.code) : error.message ? tErrors("generic", { message: error.message }) : null;

  // Prose in the reader's language (translated once, cached).
  let assessment = fit?.assessment ?? null;
  let translating = false;
  if (fit?.assessment && fit.assessmentId) {
    const needs = fit.assessmentLanguage !== locale || missingGlosses(fit.analysis, fit.assessment, locale);
    if (needs) {
      const cached = getCachedTranslation(db, fit.assessmentId, locale);
      if (cached) assessment = applyProse(fit.assessment, cached);
      else translating = true;
    }
  }

  const title = job.title ?? t("untitled");
  const where = [job.companyName, placeLabel(job.locationText ?? job.city, job.country, locale)].filter(Boolean).join(" · ");
  const processing = job.intakeStatus === "processing" || taskId !== null;

  const postingTab = (
    <div className="flex flex-col gap-4">
      {fit && <PostingOverview analysis={fit.analysis} summary={assessment?.postingSummary ?? null} locale={locale} postedAt={job.postedAt} closesAt={job.closesAt} />}
      {attachments.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("attachmentsTitle")}</CardTitle>
            <CardDescription>{t("attachmentsDescription")}</CardDescription>
          </CardHeader>
          <ul className="flex flex-wrap gap-3">
            {attachments.map((a) => (
              <li key={a.id}>
                <a href={`/api/jobs/${job.id}/attachments/${a.id}`} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border border-border">
                  {a.kind === "image" ? (
                    // eslint-disable-next-line @next/next/no-img-element -- local attachment
                    <img src={`/api/jobs/${job.id}/attachments/${a.id}`} alt={a.fileName ?? t("screenshot")} className="h-40 w-32 object-cover object-top" />
                  ) : (
                    <span className="flex h-40 w-32 items-center justify-center p-2 text-center text-xs break-all text-muted">{a.fileName}</span>
                  )}
                </a>
              </li>
            ))}
          </ul>
          {(job.intake?.illegible?.length ?? 0) > 0 && (
            <Alert className="mt-3">{t("illegible", { notes: job.intake!.illegible!.join("; ") })}</Alert>
          )}
        </Card>
      )}
      {job.description && (
        <Card>
          <CardHeader>
            <CardTitle>{t("postingTextTitle")}</CardTitle>
            <CardDescription>{attachments.length ? t("postingTextFromImages") : t("postingTextDescription")}</CardDescription>
          </CardHeader>
          <PostingTextEditor jobId={job.id} text={job.description} />
        </Card>
      )}
    </div>
  );

  return (
    <>
      <div>
        <Link href="/jobs" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          {t("back")}
        </Link>
      </div>

      <header className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {where && <p className="text-muted">{where}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {job.workplace && job.workplace !== "unknown" && <Badge tone="outline">{tEnum(`workplace.${job.workplace}`)}</Badge>}
          {job.employmentType && job.employmentType !== "unknown" && <Badge tone="outline">{tEnum(`employment.${job.employmentType}`)}</Badge>}
          <Badge tone="outline">{tEnum(`source.${job.source}`)}</Badge>
          {job.sourceUrl && (
            <Button asChild variant="ghost" size="sm">
              <a href={job.sourceUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" aria-hidden />
                {t("openOriginal")}
              </a>
            </Button>
          )}
          {job.applyUrl && job.applyUrl !== job.sourceUrl && (
            <Button asChild variant="ghost" size="sm">
              <a href={job.applyUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" aria-hidden />
                {t("openApply")}
              </a>
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusSelect jobId={job.id} status={job.status} />
          <DeleteJobButton jobId={job.id} />
        </div>
      </header>

      {query.duplicate === "1" && <Alert tone="neutral">{t("alreadyAdded")}</Alert>}
      {duplicates.length > 0 && (
        <Alert tone="neutral">
          {t("possibleDuplicate")}{" "}
          {duplicates.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ", "}
              <Link className="underline" href={`/jobs/${d.id}`}>
                {d.title ?? t("untitled")}
              </Link>
            </span>
          ))}
        </Alert>
      )}

      {processing && (
        <Card>
          <CardHeader>
            <CardTitle>{t("processingTitle")}</CardTitle>
            <CardDescription>{t("processingDescription")}</CardDescription>
          </CardHeader>
          {taskId ? <JobProgress taskId={taskId} /> : <p className="text-sm text-muted">{t("stage.queued")}</p>}
        </Card>
      )}

      {!processing && job.intakeStatus === "needs_content" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("needsContentTitle")}</CardTitle>
            <CardDescription>{t(`needsContent.${job.intake?.reason ?? "fetch_failed"}`, { site: tEnum(`site.${job.intake?.site ?? "other"}`) })}</CardDescription>
          </CardHeader>
          <PostingInput jobId={job.id} autoFocus />
        </Card>
      )}

      {!processing && job.intakeStatus === "failed" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("failedTitle")}</CardTitle>
          </CardHeader>
          {errorText && <Alert tone="danger" className="mb-4">{errorText}</Alert>}
          <PostingInput jobId={job.id} />
        </Card>
      )}

      {!processing && job.intakeStatus === "ready" && errorText && <Alert tone="danger">{t("rerunFailed", { error: errorText })}</Alert>}

      {!processing && job.intakeStatus === "ready" && fit && (
        <>
          {!fit.hasProfile && (
            <Alert tone="neutral">
              {t("needsProfile")}{" "}
              <Link href="/profile" className="underline">
                {t("needsProfileLink")}
              </Link>
            </Alert>
          )}
          {fit.hasProfile && !fit.assessment && (
            <Alert tone="neutral" className="flex flex-wrap items-center justify-between gap-3">
              {t("notAssessed")}
              <ReassessButton jobId={job.id} label={t("assessNow")} />
            </Alert>
          )}
          {fit.profileStale && (
            <Alert className="flex flex-wrap items-center justify-between gap-3">
              {t("profileChanged")}
              <ReassessButton jobId={job.id} label={t("reassess")} />
            </Alert>
          )}
          {translating && <TranslateReport jobId={job.id} />}
          <SimpleTabs
            defaultValue={fit.score && assessment ? "fit" : "posting"}
            tabs={[
              ...(fit.score && assessment
                ? [
                    {
                      value: "fit",
                      label: t("tabFit"),
                      content: <FitReport jobId={job.id} locale={locale} analysis={fit.analysis} assessment={assessment} score={fit.score} answers={job.answers ?? {}} />,
                    },
                  ]
                : []),
              { value: "posting", label: t("tabPosting"), content: postingTab },
              {
                value: "employer",
                label: t("tabEmployer"),
                content: (
                  <div className="flex flex-col gap-4">
                    {!report && (
                      <Card>
                        <CardHeader>
                          <CardTitle>{t("employerTitle", { company: job.companyName ?? t("untitled") })}</CardTitle>
                          <CardDescription>{t("employerDescription")}</CardDescription>
                        </CardHeader>
                        <ResearchControls jobId={job.id} runningTaskId={researchTask} hasReport={false} />
                      </Card>
                    )}
                    {report && (
                      <>
                        <EmployerReport report={report.report} companyName={job.companyName ?? ""} stale={report.stale} />
                        <ResearchControls key={report.id} jobId={job.id} runningTaskId={researchTask} hasReport />
                      </>
                    )}
                  </div>
                ),
              },
              {
                value: "chat",
                label: t("tabChat"),
                content: (
                  <Card>
                    <CardHeader>
                      <CardTitle>{t("chatTitle")}</CardTitle>
                      <CardDescription>{t("chatDescription")}</CardDescription>
                    </CardHeader>
                    <ChatPanel jobId={job.id} items={chatItems} hasConversation={!!conversation} />
                  </Card>
                ),
              },
            ]}
          />
        </>
      )}
    </>
  );
}
