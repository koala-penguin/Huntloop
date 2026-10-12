import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/badge";
import { currentAiMode, budgetStatus } from "@/server/ai/client";
import { appContext } from "@/server/context";
import { formatUsd } from "@/lib/format";
import { NavLinks, MobileNav } from "./nav";

export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations("common");
  const locale = await getLocale();
  const { ai } = appContext();
  const demo = currentAiMode() === "fake";
  const budget = budgetStatus(ai);
  const cap = formatUsd(budget.dailyCapUsd, locale);

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:flex md:flex-col">
        <div className="px-5 py-5">
          <p className="text-lg font-semibold tracking-tight">{t("appName")}</p>
          <p className="mt-1 text-xs text-muted">{t("tagline")}</p>
        </div>
        <NavLinks />
      </aside>
      <MobileNav appName={t("appName")} />
      <main className="flex-1 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          {demo && <Alert tone="neutral">{t("demoBanner")}</Alert>}
          {!demo && budget.exceeded && <Alert tone="danger">{t("budgetExceeded", { cap })}</Alert>}
          {!demo && !budget.exceeded && budget.warning && (
            <Alert tone="warning">{t("budgetWarning", { today: formatUsd(budget.todayUsd, locale), cap })}</Alert>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
