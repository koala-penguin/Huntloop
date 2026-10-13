import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { appContext } from "@/server/context";
import { budgetStatus, currentAiMode } from "@/server/ai/client";
import { MODELS } from "@/shared/models";
import { formatUsd } from "@/lib/format";
import { getCurrentProfile } from "@/server/repo/profile";
import { experienceYears } from "@/shared/experience";
import { listJobs } from "@/server/repo/jobs";
import { TierBadge } from "@/components/jobs/tier-badge";
import type { Tier } from "@/shared/schemas/job";

function Step({ done, title, body }: { done: boolean; title: string; body: string }) {
  const Icon = done ? CheckCircle2 : Circle;
  return (
    <li className="flex gap-3">
      <Icon className={done ? "mt-0.5 size-5 shrink-0 text-accent" : "mt-0.5 size-5 shrink-0 text-muted"} aria-hidden />
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted">{body}</p>
      </div>
    </li>
  );
}

export default async function DashboardPage() {
  const t = await getTranslations("dashboard");
  const tFit = await getTranslations("fit");
  const locale = await getLocale();
  const { ai, settings, db, user } = appContext();
  const profile = getCurrentProfile(db, user.id);
  const live = currentAiMode() === "live";
  const budget = budgetStatus(ai);
  const jobs = listJobs(db, user.id, { status: "active" });
  const bestBets = jobs.filter((j) => j.tier && ["new", "shortlisted"].includes(j.status)).slice(0, 5);

  return (
    <>
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      <div className="grid gap-4 md:grid-cols-3">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>{t("setupTitle")}</CardTitle>
          </CardHeader>
          <ol className="flex flex-col gap-4">
            <Step done={live} title={t("stepKey")} body={live ? t("stepKeyDone") : t("stepKeyTodo")} />
            <Step done={live} title={t("stepModels")} body={t("stepModelsBody", { model: MODELS[settings.defaultModel].label })} />
            <Step
              done={!!profile}
              title={t("stepProfile")}
              body={profile ? t("stepProfileDone", { version: profile.version, years: experienceYears(profile.data.experience) }) : t("stepProfileBody")}
            />
            <Step done={jobs.length > 0} title={t("stepJob")} body={jobs.length > 0 ? t("stepJobDone", { count: jobs.length }) : t("stepJobBody")} />
          </ol>
          <div className="mt-5 flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link href="/jobs">{t("addJob")}</Link>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href="/profile">{t("openProfile")}</Link>
            </Button>
            <Button asChild variant="secondary" size="sm">
              <Link href="/settings">{t("openSettings")}</Link>
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("spendTitle")}</CardTitle>
            <CardDescription>{t("spendCap", { cap: formatUsd(budget.dailyCapUsd, locale) })}</CardDescription>
          </CardHeader>
          <dl className="grid grid-cols-2 gap-3">
            <div>
              <dt className="text-xs text-muted">{t("spendToday")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatUsd(budget.todayUsd, locale)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">{t("spendMonth")}</dt>
              <dd className="text-lg font-semibold tabular-nums">{formatUsd(budget.monthUsd, locale)}</dd>
            </div>
          </dl>
          <Link href="/usage" className="mt-3 inline-block text-sm underline">
            {t("spendDetails")}
          </Link>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("bestBetsTitle")}</CardTitle>
          <CardDescription>{t("bestBetsDescription")}</CardDescription>
        </CardHeader>
        {bestBets.length ? (
          <ul className="flex flex-col divide-y divide-border">
            {bestBets.map((job) => (
              <li key={job.id}>
                <Link href={`/jobs/${job.id}`} className="flex items-center justify-between gap-3 py-2 hover:text-accent">
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{job.title}</span>
                    <span className="block truncate text-xs text-muted">{[job.companyName, job.locationText].filter(Boolean).join(" · ")}</span>
                  </span>
                  <TierBadge tier={job.tier as Tier} label={tFit(`tier.${job.tier}`)} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("bestBetsEmpty")}</p>
        )}
      </Card>
    </>
  );
}
