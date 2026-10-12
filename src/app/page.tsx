import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CheckCircle2, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { appContext } from "@/server/context";
import { budgetStatus, currentAiMode } from "@/server/ai/client";
import { MODELS } from "@/shared/models";
import { formatUsd } from "@/lib/format";

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
  const locale = await getLocale();
  const { ai, settings } = appContext();
  const live = currentAiMode() === "live";
  const budget = budgetStatus(ai);

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
            <Step done={false} title={t("stepProfile")} body={t("stepProfileBody")} />
          </ol>
          <div className="mt-5">
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
        </Card>
      </div>
    </>
  );
}
