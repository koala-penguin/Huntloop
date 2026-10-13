import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { appContext } from "@/server/context";
import { listWatches, type WatchView } from "@/server/watchlist/watchlist";
import { Alert, Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate } from "@/components/jobs/posting-overview";
import { AddWatchForm, ImportOpeningButton, WatchActions } from "@/components/search/watchlist-controls";

const ATS_LABEL: Record<string, string> = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby" };

export default async function WatchlistPage() {
  const t = await getTranslations("search.watch");
  const tSearch = await getTranslations("search");
  const locale = await getLocale();
  const { db, user } = appContext();
  const watches = listWatches(db, user.id);

  const opening = (o: WatchView["openings"][number]) => (
    <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2" data-opening={o.externalId}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <a href={o.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm font-medium hover:underline">
          {o.title}
          <ExternalLink className="size-3" aria-hidden />
        </a>
        <span className="text-xs text-muted">{[o.department, o.location, o.postedAt ? formatDate(o.postedAt, locale) : null].filter(Boolean).join(" · ")}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {o.isNew && <Badge tone="accent">{tSearch("new")}</Badge>}
        {o.matched ? <Badge tone="outline">{t("matches")}</Badge> : o.matchReason && <span className="text-xs text-muted">{t(`reason.${o.matchReason as "title_mismatch"}`)}</span>}
        {o.jobId ? (
          <Link href={`/jobs/${o.jobId}`} className="text-sm underline">
            {t("openJob")}
          </Link>
        ) : (
          <ImportOpeningButton openingId={o.id} />
        )}
      </div>
    </li>
  );

  return (
    <>
      <div>
        <Link href="/search" className="inline-flex items-center gap-1 text-sm text-muted hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          {tSearch("back")}
        </Link>
      </div>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      <Card>
        <AddWatchForm />
      </Card>

      {watches.length === 0 && <p className="rounded-lg border border-border bg-surface p-6 text-center text-sm text-muted">{t("empty")}</p>}

      {watches.map((w) => {
        const matched = w.openings.filter((o) => o.matched);
        const others = w.openings.filter((o) => !o.matched);
        return (
          <Card key={w.id} data-watch={w.board}>
            <CardHeader>
              <CardTitle>{w.name}</CardTitle>
              <CardDescription>
                {[
                  ATS_LABEL[w.atsType] ?? w.atsType,
                  t("counts", { open: w.openCount, matched: w.matchedCount }),
                  w.lastCheckedAt ? t("lastChecked", { date: formatDate(w.lastCheckedAt, locale) ?? "" }) : t("notChecked"),
                ].join(" · ")}
              </CardDescription>
            </CardHeader>
            <div className="flex flex-col gap-3">
              {w.lastError && <Alert tone="danger">{t("lastError", { error: w.lastError })}</Alert>}
              <WatchActions watchId={w.id} autoCheck={w.autoCheck} matchesToImport={matched.filter((o) => !o.jobId).length} />
              {matched.length > 0 ? (
                <ul className="flex flex-col divide-y divide-border">{matched.map(opening)}</ul>
              ) : (
                w.lastCheckedAt && <p className="text-sm text-muted">{t("noMatches")}</p>
              )}
              {others.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-sm text-muted">{t("otherRoles", { count: others.length })}</summary>
                  <ul className="mt-1 flex flex-col divide-y divide-border">{others.map(opening)}</ul>
                </details>
              )}
            </div>
          </Card>
        );
      })}
    </>
  );
}
