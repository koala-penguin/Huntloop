import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { BellRing } from "lucide-react";
import { appContext } from "@/server/context";
import { outcomeStats, pipelineBoard, type PipelineCard } from "@/server/pipeline/outcomes";
import { PIPELINE_COLUMNS } from "@/shared/schemas/pipeline";
import { TIERS } from "@/shared/schemas/job";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TierBadge } from "@/components/jobs/tier-badge";
import { formatDate } from "@/components/jobs/posting-overview";
import { StatusSelect } from "@/components/pipeline/status-select";

type Tier = (typeof TIERS)[number];

export default async function PipelinePage() {
  const t = await getTranslations("pipeline");
  const tStatus = await getTranslations("jobStatus");
  const tFit = await getTranslations("fit");
  const tJob = await getTranslations("job");
  const locale = await getLocale();
  const { db, user } = appContext();
  const board = pipelineBoard(db, user.id);
  const stats = outcomeStats(db, user.id);
  const total = PIPELINE_COLUMNS.reduce((n, c) => n + board.columns[c].length, 0);

  const jobCard = (job: PipelineCard) => (
    <li key={job.id} className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3" data-pipeline-job={job.id}>
      <Link href={`/jobs/${job.id}`} className="text-sm font-medium hover:underline">
        {job.title ?? tJob("untitled")}
      </Link>
      {job.companyName && <p className="text-xs text-muted">{job.companyName}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {job.tier && (TIERS as readonly string[]).includes(job.tier) && <TierBadge tier={job.tier as Tier} label={tFit(`tier.${job.tier as Tier}`)} />}
        {job.eligibility === "ineligible" && <Badge tone="danger">{tFit("eligibility.ineligible")}</Badge>}
      </div>
      <p className="text-xs text-muted">
        {job.appliedAt && job.status !== "shortlisted" && job.status !== "applying"
          ? t("appliedOn", { date: formatDate(job.appliedAt, locale) ?? "" })
          : t("daysInStage", { days: job.daysInStage })}
      </p>
      {job.followUp && (
        <p className="flex items-center gap-1 text-xs text-warning">
          <BellRing className="size-3.5" aria-hidden />
          {t("followUp", { days: job.daysInStage })}
        </p>
      )}
      <StatusSelect jobId={job.id} status={job.status} compact />
    </li>
  );

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      <nav aria-label={t("otherStages")} className="flex flex-wrap gap-2 text-sm">
        {(["new", "rejected", "archived"] as const).map((s) => (
          <Link key={s} href={`/jobs?status=${s}`} className="rounded-full border border-border px-3 py-1 hover:bg-accent-soft">
            {t("stageCount", { stage: tStatus(s), count: board.counts[s] })}
          </Link>
        ))}
      </nav>

      {total === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("emptyTitle")}</CardTitle>
            <CardDescription>{t("emptyDescription")}</CardDescription>
          </CardHeader>
          <Link href="/jobs" className="text-sm underline">
            {t("goToJobs")}
          </Link>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-5">
          {PIPELINE_COLUMNS.map((column) => (
            <section key={column} aria-labelledby={`col-${column}`} className="flex flex-col gap-2" data-pipeline-column={column}>
              <h2 id={`col-${column}`} className="flex items-center justify-between text-sm font-medium">
                {tStatus(column)}
                <span className="text-xs text-muted">{board.columns[column].length}</span>
              </h2>
              {board.columns[column].length ? (
                <ul className="flex flex-col gap-2">{board.columns[column].map(jobCard)}</ul>
              ) : (
                <p className="rounded-md border border-dashed border-border p-3 text-xs text-muted">{t("emptyColumn")}</p>
              )}
            </section>
          ))}
        </div>
      )}

      {stats.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("statsTitle")}</CardTitle>
            <CardDescription>{t("statsDescription")}</CardDescription>
          </CardHeader>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 font-medium">{t("statsTier")}</th>
                <th className="py-1 font-medium">{t("statsApplied")}</th>
                <th className="py-1 font-medium">{t("statsInterviews")}</th>
                <th className="py-1 font-medium">{t("statsOffers")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.map((row) => (
                <tr key={row.tier} className="border-t border-border" data-tier-outcome={row.tier}>
                  <td className="py-1.5">{(TIERS as readonly string[]).includes(row.tier) ? tFit(`tier.${row.tier as Tier}`) : t("unscored")}</td>
                  <td className="py-1.5">{row.applied}</td>
                  <td className="py-1.5">{t("rate", { count: row.interviews, percent: Math.round((row.interviews / row.applied) * 100) })}</td>
                  <td className="py-1.5">{row.offers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
