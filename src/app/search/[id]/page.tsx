import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft } from "lucide-react";
import { appContext } from "@/server/context";
import { getSearch, searchResults, type SearchResultJob } from "@/server/search/run";
import { activeSearchTask, latestSearchTask } from "@/server/search/tasks";
import { searchFiltersSchema, type SearchRunSummary } from "@/shared/schemas/search";
import { TIERS, type Tier } from "@/shared/schemas/job";
import { placeLabel } from "@/shared/countries";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { TierBadge } from "@/components/jobs/tier-badge";
import { FilterEditor } from "@/components/search/filter-editor";
import { SavedSearchControls } from "@/components/search/saved-search-controls";

function ResultRow({ result, locale, t, tFit }: { result: SearchResultJob; locale: string; t: Awaited<ReturnType<typeof getTranslations<"search">>>; tFit: Awaited<ReturnType<typeof getTranslations<"fit">>> }) {
  const { job } = result;
  return (
    <li>
      <Link href={`/jobs/${job.id}`} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 hover:border-accent sm:flex-row sm:items-center sm:justify-between" data-result={job.id}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-medium">{job.title ?? t("untitled")}</span>
          <span className="truncate text-sm text-muted">{[job.companyName, placeLabel(job.locationText ?? job.city, job.country, locale)].filter(Boolean).join(" · ")}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {result.isNew && <Badge tone="accent">{t("new")}</Badge>}
          {job.tier && <TierBadge tier={job.tier as Tier} label={tFit(`tier.${job.tier}`)} />}
          {job.eligibility === "verify" && <Badge tone="warning">{tFit("eligibility.verify")}</Badge>}
          {job.tier && !job.descriptionIsFull && <Badge tone="outline">{t("provisional")}</Badge>}
          {job.intakeStatus === "failed" && <Badge tone="danger">{t("failed")}</Badge>}
          {result.sources.map((s) => (
            <Badge key={s} tone="neutral">
              {t(`source.${s}`)}
            </Badge>
          ))}
        </div>
      </Link>
    </li>
  );
}

export default async function SearchDetailPage({ params }: PageProps<"/search/[id]">) {
  const { id } = await params;
  const t = await getTranslations("search");
  const tFit = await getTranslations("fit");
  const locale = await getLocale();
  const { db, user } = appContext();
  const search = getSearch(db, user.id, Number(id));
  if (!search) notFound();

  const running = activeSearchTask(db, user.id, search.id);
  const results = searchResults(db, user.id, search.id, latestSearchTask(db, user.id, search.id));
  const filters = searchFiltersSchema.safeParse(search.filters);
  const summary = search.lastSummary as SearchRunSummary | null;
  const byTier = (tier: Tier) => results.filter((r) => r.job.tier === tier && r.job.eligibility !== "ineligible").sort((a, b) => (b.job.score ?? 0) - (a.job.score ?? 0));
  const ineligible = results.filter((r) => r.job.eligibility === "ineligible");
  const unscored = results.filter((r) => !r.job.tier && r.job.eligibility !== "ineligible");
  const fromAdzuna = results.some((r) => r.sources.includes("adzuna"));

  return (
    <>
      <div>
        <Link href="/search" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          {t("back")}
        </Link>
      </div>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{search.name ?? (search.query || t("fromPreferences"))}</h1>
        <p className="text-muted">{t("detailSubtitle")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("filtersTitle")}</CardTitle>
          <CardDescription>{t("filtersDescription")}</CardDescription>
        </CardHeader>
        <FilterEditor key={`${running ?? "idle"}-${search.lastRunAt?.getTime() ?? 0}`} searchId={search.id} filters={filters.success ? filters.data : null} runningTaskId={running} />
      </Card>

      {summary && !running && (
        <Card>
          <CardHeader>
            <CardTitle>{t("summaryTitle")}</CardTitle>
          </CardHeader>
          <ul className="flex flex-col gap-1 text-sm">
            {Object.entries(summary.sources).map(([source, s]) => (
              <li key={source}>
                {s!.error
                  ? t("sourceError", {
                      source: t(`source.${source}`),
                      error: t(`sourceErrorReason.${["quota", "budget", "refusal", "browser_unavailable", "subscription_limit", "cli_login", "cli_missing"].includes(s!.error) ? s!.error : "other"}`),
                    })
                  : s!.partial === "quota"
                    ? t("sourceLeadsPartial", { source: t(`source.${source}`), count: s!.leads })
                    : t("sourceLeads", { source: t(`source.${source}`), count: s!.leads })}
              </li>
            ))}
            <li>{t("summaryCounts", { unique: summary.unique, known: summary.known, screened: summary.screened, deep: summary.deep })}</li>
            {Object.keys(summary.filtered).length > 0 && (
              <li className="text-muted">
                {t("filteredOut")}{" "}
                {Object.entries(summary.filtered)
                  .map(([reason, count]) => t("filteredReason", { reason: t(`filterReason.${reason}`), count }))
                  .join(", ")}
              </li>
            )}
            {summary.stoppedBy === "budget" && <li className="text-warning">{t("stoppedByBudget")}</li>}
            {summary.stoppedBy === "limit" && <li className="text-warning">{t("stoppedByLimit")}</li>}
          </ul>
        </Card>
      )}

      <Card data-saved-search={search.saved ? "saved" : "unsaved"}>
        <CardHeader>
          <CardTitle>{search.saved ? t("saved.titleSaved") : t("saved.title")}</CardTitle>
          <CardDescription>{t("saved.description")}</CardDescription>
        </CardHeader>
        <SavedSearchControls
          key={`${search.saved}-${search.schedule}-${search.name ?? ""}`}
          searchId={search.id}
          saved={search.saved}
          name={search.name ?? (search.query || t("fromPreferences"))}
          daily={search.schedule === "daily"}
          scheduleNote={search.scheduleNote}
        />
      </Card>

      {results.length === 0 && !running && <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">{t("noResults")}</p>}

      {TIERS.map((tier) => {
        const list = byTier(tier);
        if (!list.length) return null;
        return (
          <section key={tier} className="flex flex-col gap-2" aria-labelledby={`tier-${tier}`}>
            <h2 id={`tier-${tier}`} className="flex items-center gap-2 text-sm font-semibold">
              <TierBadge tier={tier} label={tFit(`tier.${tier}`)} />
              {t("tierCount", { count: list.length })}
            </h2>
            <ul className="flex flex-col gap-2">
              {list.map((r) => (
                <ResultRow key={r.job.id} result={r} locale={locale} t={t} tFit={tFit} />
              ))}
            </ul>
          </section>
        );
      })}

      {unscored.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">{t("unscored")}</h2>
          <ul className="flex flex-col gap-2">
            {unscored.map((r) => (
              <ResultRow key={r.job.id} result={r} locale={locale} t={t} tFit={tFit} />
            ))}
          </ul>
        </section>
      )}

      {ineligible.length > 0 && (
        <details className="flex flex-col gap-2">
          <summary className="cursor-pointer text-sm text-muted">{t("ineligible", { count: ineligible.length })}</summary>
          <ul className="mt-2 flex flex-col gap-2">
            {ineligible.map((r) => (
              <ResultRow key={r.job.id} result={r} locale={locale} t={t} tFit={tFit} />
            ))}
          </ul>
        </details>
      )}

      {fromAdzuna && (
        <p className="text-xs text-muted">
          <a href="https://www.adzuna.com.au" target="_blank" rel="noreferrer" className="underline">
            {t("adzunaAttribution")}
          </a>
        </p>
      )}
    </>
  );
}
