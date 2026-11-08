import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { appContext } from "@/server/context";
import { budgetStatus } from "@/server/ai/client";
import { subscriptionUsage } from "@/server/ai/claude-code/limits";
import { usageReport, type UsageRow } from "@/server/repo/usage";
import { AI_TASKS, type AiTask } from "@/shared/ai-settings";
import { MODELS, isModelId } from "@/shared/models";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SpendChart, type SpendMetric } from "@/components/usage/spend-chart";

const DAYS = 30;

export default async function UsagePage() {
  const t = await getTranslations("usage");
  const tTasks = await getTranslations("aiTasks");
  const locale = await getLocale();
  const { db, user, ai } = appContext();
  const budget = budgetStatus(ai);
  const report = usageReport(db, user.id, DAYS);
  const number = (n: number) => new Intl.NumberFormat(locale, { notation: n >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(n);
  const ratio = budget.dailyCapUsd > 0 ? budget.todayUsd / budget.dailyCapUsd : 0;
  const limits = subscriptionUsage();
  const when = (d: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
  const percent = (n: number) => new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(n);
  const showSubscription = report.subscriptionCalls > 0 || !!limits;
  // Someone who only uses the subscription gets its chart instead of an empty spend chart.
  const showSpendChart = report.totalUsd > 0 || report.subscriptionCalls === 0;

  const dailyCard = (metric: SpendMetric) => (
    <Card data-chart={metric}>
      <CardHeader>
        <CardTitle>{t(metric === "api" ? "chartTitle" : "subscriptionChartTitle")}</CardTitle>
        <CardDescription>{t(metric === "api" ? "chartDescription" : "subscriptionChartDescription")}</CardDescription>
      </CardHeader>
      <SpendChart days={report.days} metric={metric} />
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-muted">{t("showTable")}</summary>
        <table className="mt-2 w-full text-left text-sm">
          <thead className="text-xs text-muted">
            <tr>
              <th className="py-1 font-medium">{t("table.date")}</th>
              <th className="py-1 text-right font-medium">{t("table.calls")}</th>
              <th className="py-1 text-right font-medium">{t(metric === "api" ? "table.cost" : "table.apiValue")}</th>
            </tr>
          </thead>
          <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
            {[...report.days].reverse().map((d) => (
              <tr key={d.date} className="border-t border-border">
                <td className="py-1">{d.date}</td>
                <td className="py-1 text-right">{metric === "api" ? d.calls : d.subscriptionCalls}</td>
                <td className="py-1 text-right">{formatUsd(metric === "api" ? d.costUsd : d.subscriptionUsd, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Card>
  );

  const table = (rows: UsageRow[], label: (key: string) => string, caption: string) => (
    <table className="w-full text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="text-xs text-muted">
        <tr>
          <th className="py-1 font-medium">{caption}</th>
          <th className="py-1 text-right font-medium">{t("table.calls")}</th>
          <th className="py-1 text-right font-medium">{t("table.tokens")}</th>
          <th className="py-1 text-right font-medium">{t("table.cached")}</th>
          <th className="py-1 text-right font-medium">{t("table.searches")}</th>
          <th className="py-1 text-right font-medium">{t("table.cost")}</th>
          {showSubscription && <th className="py-1 text-right font-medium">{t("table.subscription")}</th>}
        </tr>
      </thead>
      <tbody style={{ fontVariantNumeric: "tabular-nums" }}>
        {rows.map((r) => {
          const input = r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
          return (
            <tr key={r.key} className="border-t border-border" data-usage-row={r.key}>
              <td className="py-1.5">{label(r.key)}</td>
              <td className="py-1.5 text-right">{number(r.calls)}</td>
              <td className="py-1.5 text-right">{t("table.tokensValue", { input: number(input), output: number(r.outputTokens) })}</td>
              <td className="py-1.5 text-right">{input ? `${Math.round((r.cacheReadTokens / input) * 100)}%` : "–"}</td>
              <td className="py-1.5 text-right">{number(r.webSearches)}</td>
              <td className="py-1.5 text-right">{formatUsd(r.costUsd, locale)}</td>
              {showSubscription && (
                <td className="py-1.5 text-right">{r.subscriptionCalls ? t("table.subscriptionValue", { calls: number(r.subscriptionCalls), value: formatUsd(r.subscriptionUsd, locale) }) : "–"}</td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
  const taskLabel = (key: string) => ((AI_TASKS as readonly string[]).includes(key) ? tTasks(`${key as AiTask}.name`) : key);
  const modelLabel = (key: string) => (isModelId(key) ? MODELS[key].label : key);

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs text-muted">{t("today")}</p>
          <p className="text-2xl font-semibold" data-stat="today">
            {formatUsd(budget.todayUsd, locale)}
          </p>
          <p className="text-xs text-muted">{t("ofDailyCap", { cap: formatUsd(budget.dailyCapUsd, locale) })}</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-accent-soft" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.min(ratio, 1) * 100)} aria-label={t("today")}>
            <div className={cn("h-full rounded-full", budget.exceeded ? "bg-danger" : budget.warning ? "bg-warning" : "bg-accent")} style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
          </div>
        </Card>
        <Card>
          <p className="text-xs text-muted">{t("month")}</p>
          <p className="text-2xl font-semibold">{formatUsd(budget.monthUsd, locale)}</p>
          <p className="text-xs text-muted">{budget.monthlyCapUsd !== null ? t("ofMonthlyCap", { cap: formatUsd(budget.monthlyCapUsd, locale) }) : t("noMonthlyCap")}</p>
        </Card>
        <Card>
          <p className="text-xs text-muted">{t("last30")}</p>
          <p className="text-2xl font-semibold">{formatUsd(report.totalUsd, locale)}</p>
          <p className="text-xs text-muted">{t("calls", { count: report.calls })}</p>
        </Card>
      </div>

      {report.simulatedCalls > 0 && <p className="text-sm text-muted">{t("simulated", { count: report.simulatedCalls })}</p>}

      {showSubscription && (
        <Card data-section="subscription">
          <CardHeader>
            <CardTitle>{t("subscriptionTitle")}</CardTitle>
            <CardDescription>{t("subscriptionDescription")}</CardDescription>
          </CardHeader>
          <div className="grid gap-4 sm:grid-cols-3">
            <div>
              <p className="text-xs text-muted">{t("last30")}</p>
              <p className="text-2xl font-semibold">{t("calls", { count: report.subscriptionCalls })}</p>
              <p className="text-xs text-muted">{t("subscriptionValue", { value: formatUsd(report.subscriptionUsd, locale) })}</p>
            </div>
            {(["fiveHour", "sevenDay"] as const).map((key) => {
              const w = limits?.[key];
              return (
                <div key={key}>
                  <p className="text-xs text-muted">{t(`window.${key}`)}</p>
                  <p className="text-2xl font-semibold" style={{ fontVariantNumeric: "tabular-nums" }}>
                    {w?.utilization !== null && w?.utilization !== undefined ? percent(w.utilization) : "–"}
                  </p>
                  <p className="text-xs text-muted">{w?.resetsAt ? t("window.resets", { time: when(w.resetsAt) }) : t("window.unknown")}</p>
                </div>
              );
            })}
          </div>
          {limits?.status === "rejected" && limits.resetsAt && <p className="mt-3 text-sm text-warning">{t("limitReached", { time: when(limits.resetsAt) })}</p>}
          {limits && <p className="mt-3 text-xs text-muted">{t("limitsAsOf", { time: when(limits.updatedAt) })}</p>}
        </Card>
      )}

      {showSpendChart && dailyCard("api")}
      {report.subscriptionCalls > 0 && dailyCard("subscription")}

      <Card>
        <CardHeader>
          <CardTitle>{t("byTaskTitle")}</CardTitle>
          <CardDescription>{t("byTaskDescription")}</CardDescription>
        </CardHeader>
        {report.byTask.length ? table(report.byTask, taskLabel, t("table.task")) : <p className="text-sm text-muted">{t("empty")}</p>}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("byModelTitle")}</CardTitle>
          <CardDescription>{t("byModelDescription")}</CardDescription>
        </CardHeader>
        {report.byModel.length ? table(report.byModel, modelLabel, t("table.model")) : <p className="text-sm text-muted">{t("empty")}</p>}
        <p className="mt-3 text-xs text-muted">
          {t("settingsHint")}{" "}
          <Link href="/settings" className="underline">
            {t("settingsLink")}
          </Link>
        </p>
      </Card>
    </>
  );
}
