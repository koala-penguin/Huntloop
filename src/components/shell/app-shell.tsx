import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/badge";
import { budgetStatus, modeFor, resolveMode } from "@/server/ai/client";
import { subscriptionLimitedUntil } from "@/server/ai/claude-code/limits";
import { appContext } from "@/server/context";
import { readEnv } from "@/server/config/env";
import { formatUsd } from "@/lib/format";
import { NavLinks, MobileNav } from "./nav";
import { ConnectionSwitch } from "./connection-switch";

export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations("common");
  const locale = await getLocale();
  const { ai, settings } = appContext();
  const active = settings.connection;
  const mode = await resolveMode(active);
  const demo = mode === "fake";
  const ready = { api: modeFor("api") === "api", subscription: modeFor("subscription") === "claude_code" };
  const demoReason = readEnv().HUNTLOOP_AI === "fake" ? "forced" : active;
  const budget = budgetStatus(ai);
  const cap = formatUsd(budget.dailyCapUsd, locale);
  const limitedUntil = mode === "claude_code" ? subscriptionLimitedUntil() : null;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:flex md:flex-col">
        <div className="px-5 py-5">
          <p className="text-lg font-semibold tracking-tight">{t("appName")}</p>
          <p className="mt-1 text-xs text-muted">{t("tagline")}</p>
        </div>
        <NavLinks />
        <ConnectionSwitch active={active} ready={ready} className="mt-auto px-5 pb-5" />
      </aside>
      <MobileNav appName={t("appName")} />
      <main className="flex-1 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          <ConnectionSwitch active={active} ready={ready} className="md:hidden" />
          {demo && <Alert tone="neutral">{t(`demoBanner.${demoReason}`)}</Alert>}
          {limitedUntil && (
            <Alert tone="warning">
              {t("subscriptionLimited", { time: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(limitedUntil) })}
            </Alert>
          )}
          {mode === "api" && budget.exceeded && <Alert tone="danger">{t("budgetExceeded", { cap })}</Alert>}
          {mode === "api" && !budget.exceeded && budget.warning && (
            <Alert tone="warning">{t("budgetWarning", { today: formatUsd(budget.todayUsd, locale), cap })}</Alert>
          )}
          {children}
        </div>
      </main>
    </div>
  );
}
