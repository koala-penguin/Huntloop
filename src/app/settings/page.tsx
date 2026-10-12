import { getTranslations } from "next-intl/server";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { LanguageForm } from "@/components/settings/language-form";
import { AiSettingsForm } from "@/components/settings/ai-settings-form";
import { appContext } from "@/server/context";
import { spendSummary } from "@/server/repo/usage";
import { readEnv } from "@/server/config/env";

export default async function SettingsPage() {
  const t = await getTranslations("settings");
  const tCommon = await getTranslations("common");
  const { db, user, settings } = appContext();
  const spend = spendSummary(db, user.id);
  const env = readEnv();
  const keys = [
    { label: t("keyAnthropic"), set: !!env.ANTHROPIC_API_KEY, optional: false },
    { label: t("keyAdzuna"), set: !!(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY), optional: true },
    { label: t("keyJsearch"), set: !!env.JSEARCH_API_KEY, optional: true },
  ];

  return (
    <>
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted">{t("subtitle")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("languageTitle")}</CardTitle>
          <CardDescription>{t("languageDescription")}</CardDescription>
        </CardHeader>
        <LanguageForm />
      </Card>

      <AiSettingsForm initial={settings} spentTodayUsd={spend.todayUsd} spentMonthUsd={spend.monthUsd} />

      <Card>
        <CardHeader>
          <CardTitle>{t("keysTitle")}</CardTitle>
          <CardDescription>{t("keysDescription")}</CardDescription>
        </CardHeader>
        <ul className="flex flex-col gap-2">
          {keys.map((key) => (
            <li key={key.label} className="flex items-center justify-between gap-4 text-sm">
              <span>
                {key.label}
                {key.optional && <span className="ml-2 text-xs text-muted">{tCommon("optional")}</span>}
              </span>
              <Badge tone={key.set ? "neutral" : key.optional ? "outline" : "warning"}>
                {key.set ? tCommon("configured") : tCommon("missing")}
              </Badge>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
