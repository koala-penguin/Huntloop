import { getTranslations } from "next-intl/server";
import type { PostingAnalysis } from "@/shared/schemas/job";
import { placeLabel } from "@/shared/countries";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export function formatDate(date: Date | null, locale: string): string | null {
  return date ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(date) : null;
}

/** "Posting at a glance": the plain-words summary plus the facts that matter for applying. */
export async function PostingOverview({
  analysis,
  summary,
  locale,
  postedAt,
  closesAt,
}: {
  analysis: PostingAnalysis;
  summary: string | null;
  locale: string;
  postedAt: Date | null;
  closesAt: Date | null;
}) {
  const t = await getTranslations("posting");
  const tEnum = await getTranslations("jobEnums");
  const salary = analysis.salary;
  const salaryText =
    salary?.text ??
    (salary && (salary.min || salary.max)
      ? `${salary.currency ?? ""} ${[salary.min, salary.max].filter((v) => v !== null).map((v) => new Intl.NumberFormat(locale).format(v!)).join(" – ")}`.trim()
      : null);
  const facts: Array<[string, string | null]> = [
    [t("location"), placeLabel(analysis.locationText, analysis.country, locale)],
    [t("workplace"), tEnum(`workplace.${analysis.workplace}`) + (analysis.remoteScope ? ` (${analysis.remoteScope})` : "")],
    [t("employmentType"), tEnum(`employment.${analysis.employmentType}`)],
    [t("seniority"), analysis.seniority ? tEnum(`seniority.${analysis.seniority}`) : null],
    [t("salary"), salaryText ? `${salaryText}${salary && salary.basis !== "unknown" ? ` · ${tEnum(`salaryBasis.${salary.basis}`)}` : ""}` : null],
    [t("posted"), formatDate(postedAt, locale) ?? analysis.postedText],
    [t("closes"), formatDate(closesAt, locale)],
    [t("sponsorship"), tEnum(`sponsorship.${analysis.sponsorship}`)],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      {summary && <p className="mb-4 text-sm">{summary}</p>}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {facts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-xs text-muted">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {analysis.sponsorshipQuote && (
        <p className="mt-3 text-xs text-muted">
          <q>{analysis.sponsorshipQuote}</q>
        </p>
      )}
      {analysis.ghostSignals.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {analysis.ghostSignals.map((g, i) => (
            <Badge key={i} tone="warning">
              {g}
            </Badge>
          ))}
        </div>
      )}
    </Card>
  );
}
