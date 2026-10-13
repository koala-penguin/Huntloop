import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { appContext } from "@/server/context";
import { listSearches } from "@/server/search/run";
import { newInLatestRun } from "@/server/search/tasks";
import { listWatches } from "@/server/watchlist/watchlist";
import { adzunaCredentials } from "@/server/sources/adzuna";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/badge";
import { SearchForm } from "@/components/search/search-form";
import { formatDate } from "@/components/jobs/posting-overview";

export default async function SearchPage() {
  const t = await getTranslations("search");
  const locale = await getLocale();
  const { db, user } = appContext();
  const all = listSearches(db, user.id, 50);
  const saved = all.filter((s) => s.saved);
  const recent = all.filter((s) => !s.saved).slice(0, 20);
  const watches = listWatches(db, user.id);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      <Card>
        <SearchForm />
      </Card>

      {!adzunaCredentials() && <Alert tone="neutral">{t("adzunaMissing")}</Alert>}

      <Card>
        <CardHeader>
          <CardTitle>{t("saved.listTitle")}</CardTitle>
          <CardDescription>{t("saved.listDescription")}</CardDescription>
        </CardHeader>
        {saved.length === 0 ? (
          <p className="text-sm text-muted">{t("saved.listEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border" data-saved-searches>
            {saved.map((s) => {
              const fresh = newInLatestRun(db, user.id, s.id);
              return (
                <li key={s.id}>
                  <Link href={`/search/${s.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:text-accent">
                    <span className="min-w-0 truncate text-sm font-medium">{s.name ?? (s.query || t("fromPreferences"))}</span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                      {fresh > 0 && <Badge tone="accent">{t("saved.newCount", { count: fresh })}</Badge>}
                      {s.schedule === "daily" && <Badge tone="outline">{t("saved.dailyBadge")}</Badge>}
                      {s.lastRunAt ? t("lastRun", { date: formatDate(s.lastRunAt, locale)! }) : t("notRunYet")}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("watch.summaryTitle")}</CardTitle>
          <CardDescription>{t("watch.summaryDescription")}</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-2 text-sm">
          {watches.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {watches.map((w) => (
                <li key={w.id} className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-xs">
                  {w.name}
                  {w.newMatchedCount > 0 && <Badge tone="accent">{t("watch.newMatches", { count: w.newMatchedCount })}</Badge>}
                </li>
              ))}
            </ul>
          )}
          <Link href="/search/watchlist" className="underline">
            {watches.length ? t("watch.manage") : t("watch.start")}
          </Link>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("recentTitle")}</CardTitle>
          <CardDescription>{t("recentDescription")}</CardDescription>
        </CardHeader>
        {recent.length === 0 ? (
          <p className="text-sm text-muted">{t("recentEmpty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {recent.map((s) => (
              <li key={s.id}>
                <Link href={`/search/${s.id}`} className="flex items-center justify-between gap-3 py-2 hover:text-accent">
                  <span className="min-w-0 truncate text-sm font-medium">{s.query || t("fromPreferences")}</span>
                  <span className="shrink-0 text-xs text-muted">{s.lastRunAt ? t("lastRun", { date: formatDate(s.lastRunAt, locale)! }) : t("notRunYet")}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
