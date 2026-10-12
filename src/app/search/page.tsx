import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { appContext } from "@/server/context";
import { listSearches } from "@/server/search/run";
import { adzunaCredentials } from "@/server/sources/adzuna";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert } from "@/components/ui/badge";
import { SearchForm } from "@/components/search/search-form";
import { formatDate } from "@/components/jobs/posting-overview";

export default async function SearchPage() {
  const t = await getTranslations("search");
  const locale = await getLocale();
  const { db, user } = appContext();
  const recent = listSearches(db, user.id);

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
