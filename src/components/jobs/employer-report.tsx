import { getTranslations } from "next-intl/server";
import { ExternalLink } from "lucide-react";
import type { CompanyReport } from "@/shared/schemas/company";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

/** Employer research: sourced, dated claims per section, hiring numbers from code, advice for this job. */
export async function EmployerReport({ report, companyName, stale }: { report: CompanyReport; companyName: string; stale: boolean }) {
  const t = await getTranslations("employer");
  const facts: Array<[string, string | null]> = [
    [t("fact.website"), report.facts.website],
    [t("fact.headquarters"), report.facts.headquarters],
    [t("fact.founded"), report.facts.founded],
    [t("fact.size"), report.facts.size],
    [t("fact.ownership"), report.facts.ownership !== "unknown" ? t(`ownership.${report.facts.ownership}`) : null],
    [t("fact.industry"), report.facts.industry],
  ];
  const forYou = (["talkingPoints", "cvAngles", "questionsToAsk", "referralAngles"] as const).filter((k) => report.forYou[k].length);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{companyName}</CardTitle>
          <CardDescription>{t("asOf", { date: report.asOf })}</CardDescription>
        </CardHeader>
        <p className="text-sm">{report.summary}</p>
        <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
          {facts
            .filter(([, v]) => v)
            .map(([label, value]) => (
              <div key={label} className="flex min-w-0 flex-col">
                <dt className="text-xs text-muted">{label}</dt>
                <dd className="truncate">{value}</dd>
              </div>
            ))}
        </dl>
        {stale && <p className="mt-3 text-xs text-warning">{t("stale")}</p>}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("hiringTitle")}</CardTitle>
          <CardDescription>{t("hiringDescription")}</CardDescription>
        </CardHeader>
        {report.hiring.ats ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>{t("atsOpenRoles", { count: report.hiring.ats.total, board: report.hiring.ats.type })}</p>
            <div className="flex flex-wrap gap-1.5">
              {report.hiring.ats.byDepartment.map((d) => (
                <Badge key={d.name} tone="outline">{`${d.name} · ${d.count}`}</Badge>
              ))}
            </div>
            {report.hiring.ats.byLocation.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {report.hiring.ats.byLocation.map((d) => (
                  <Badge key={d.name} tone="neutral">{`${d.name} · ${d.count}`}</Badge>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">{t("noAts")}</p>
        )}
        <p className="mt-2 text-xs text-muted">{t("trackedJobs", { count: report.hiring.trackedJobs })}</p>
      </Card>

      {report.sections.map((section) => (
        <Card key={section.key} data-section={section.key}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{t(`section.${section.key}`)}</h2>
            <Badge tone="outline">{t(`confidence.${section.confidence}`)}</Badge>
          </div>
          <ul className="flex flex-col gap-3">
            {section.claims.map((claim, i) => (
              <li key={i} className="flex flex-col gap-0.5 text-sm">
                <span>{claim.text}</span>
                <a href={claim.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted hover:text-foreground">
                  <ExternalLink className="size-3" aria-hidden />
                  {host(claim.sourceUrl)}
                  {claim.date ? ` · ${claim.date}` : ""}
                </a>
              </li>
            ))}
          </ul>
        </Card>
      ))}

      {forYou.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("forYouTitle")}</CardTitle>
          </CardHeader>
          <div className="grid gap-4 md:grid-cols-2">
            {forYou.map((key) => (
              <section key={key} className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">{t(`forYou.${key}`)}</h3>
                <List items={report.forYou[key]} />
              </section>
            ))}
          </div>
        </Card>
      )}

      <p className="text-xs text-muted">
        {t("sourcesNote", { count: report.sources.length })}
        {report.droppedClaims > 0 ? ` ${t("droppedClaims", { count: report.droppedClaims })}` : ""}
      </p>
    </div>
  );
}
