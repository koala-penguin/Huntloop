import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { appContext } from "@/server/context";
import { countIneligible, listJobs, type JobFilters } from "@/server/repo/jobs";
import { JOB_STATUSES, TIERS, type JobStatus } from "@/shared/schemas/job";
import { placeLabel } from "@/shared/countries";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PostingInput } from "@/components/jobs/posting-input";
import { TierBadge } from "@/components/jobs/tier-badge";
import { formatDate } from "@/components/jobs/posting-overview";
import { cn } from "@/lib/cn";

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={cn("rounded-full border px-3 py-1 text-xs", active ? "border-accent bg-accent text-accent-foreground" : "border-border hover:bg-accent-soft")}
    >
      {children}
    </Link>
  );
}

export default async function JobsPage({ searchParams }: PageProps<"/jobs">) {
  const query = await searchParams;
  const t = await getTranslations("jobs");
  const tFit = await getTranslations("fit");
  const tStatus = await getTranslations("jobStatus");
  const tEnum = await getTranslations("jobEnums");
  const locale = await getLocale();
  const { db, user } = appContext();

  const status = typeof query.status === "string" && (query.status === "active" || JOB_STATUSES.includes(query.status as JobStatus)) ? (query.status as JobFilters["status"]) : undefined;
  const tier = typeof query.tier === "string" && TIERS.includes(query.tier as never) ? query.tier : undefined;
  const showIneligible = query.ineligible === "1";
  const jobs = listJobs(db, user.id, { status, tier, showIneligible });
  const hidden = showIneligible ? 0 : countIneligible(db, user.id);

  const href = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const next = { status, tier, ineligible: showIneligible ? "1" : undefined, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    const s = params.toString();
    return s ? `/jobs?${s}` : "/jobs";
  };

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("addTitle")}</CardTitle>
          <CardDescription>{t("addDescription")}</CardDescription>
        </CardHeader>
        <PostingInput />
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="jobs-list-heading">
        <h2 id="jobs-list-heading" className="sr-only">
          {t("listHeading")}
        </h2>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("filterStatus")}>
          <Chip href={href({ status: undefined })} active={!status}>
            {t("allStatuses")}
          </Chip>
          <Chip href={href({ status: "active" })} active={status === "active"}>
            {t("activeStatuses")}
          </Chip>
          {JOB_STATUSES.map((s) => (
            <Chip key={s} href={href({ status: s })} active={status === s}>
              {tStatus(s)}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("filterTier")}>
          <Chip href={href({ tier: undefined })} active={!tier}>
            {t("allTiers")}
          </Chip>
          {TIERS.map((x) => (
            <Chip key={x} href={href({ tier: x })} active={tier === x}>
              {tFit(`tier.${x}`)}
            </Chip>
          ))}
          <Chip href={href({ ineligible: showIneligible ? undefined : "1" })} active={showIneligible}>
            {t("showIneligible")}
          </Chip>
        </div>

        {jobs.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {jobs.map((job) => (
              <li key={job.id}>
                <Link href={`/jobs/${job.id}`} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 hover:border-accent sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-medium">{job.title ?? t("untitled")}</span>
                    <span className="truncate text-sm text-muted">
                      {[job.companyName, placeLabel(job.locationText ?? job.city, job.country, locale)].filter(Boolean).join(" · ") || tEnum(`source.${job.source}`)}
                    </span>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {job.intakeStatus === "processing" && <Badge tone="neutral">{t("processing")}</Badge>}
                    {job.intakeStatus === "needs_content" && <Badge tone="warning">{t("needsContent")}</Badge>}
                    {job.intakeStatus === "failed" && <Badge tone="danger">{t("failed")}</Badge>}
                    {job.tier && <TierBadge tier={job.tier as (typeof TIERS)[number]} label={tFit(`tier.${job.tier}`)} />}
                    {job.eligibility && job.eligibility !== "eligible" && (
                      <Badge tone={job.eligibility === "ineligible" ? "danger" : "warning"}>{tFit(`eligibility.${job.eligibility}`)}</Badge>
                    )}
                    {job.status !== "new" && <Badge tone="outline">{tStatus(job.status as JobStatus)}</Badge>}
                    {job.postedAt && <span className="text-xs text-muted">{t("posted", { date: formatDate(job.postedAt, locale)! })}</span>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {hidden > 0 && (
          <p className="text-sm text-muted">
            {t("hiddenIneligible", { count: hidden })}{" "}
            <Link className="underline" href={href({ ineligible: "1" })}>
              {t("showThem")}
            </Link>
          </p>
        )}
      </section>
    </>
  );
}
