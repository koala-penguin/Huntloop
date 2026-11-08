import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { Alert } from "@/components/ui/badge";
import { budgetStatus, modeFor, resolveMode } from "@/server/ai/client";
import { cachedClaudeCodeStatus, claudeCodeStatusExpired, getClaudeCodeStatus, subscriptionReady } from "@/server/ai/claude-code/status";
import { subscriptionLimitedUntil } from "@/server/ai/claude-code/limits";
import { appContext } from "@/server/context";
import { readEnv } from "@/server/config/env";
import { formatUsd } from "@/lib/format";
import { NavLinks, MobileNav } from "./nav";
import { ConnectionSwitch } from "./connection-switch";
import { shellAiStatus } from "./ai-status";

export async function AppShell({ children }: { children: ReactNode }) {
  const t = await getTranslations("common");
  const locale = await getLocale();
  const { ai, settings } = appContext();
  const active = settings.connection;
  const mode = await resolveMode(active);
  const env = readEnv().HUNTLOOP_AI;
  const demoForced = env === "fake";
  // The sidebar switch warns before switching to a connection that isn't ready; it needs the CLI
  // status even when the API is active. An expired "not ready" answer is re-checked in the
  // background (the page doesn't wait for a slow CLI).
  if (!demoForced && !cachedClaudeCodeStatus()) await getClaudeCodeStatus();
  else if (!demoForced && claudeCodeStatusExpired()) void getClaudeCodeStatus().catch(() => {});
  const cliReady = env === "claude-code" || subscriptionReady();
  // Forced demo mode simulates every connection anyway, so no warning is needed.
  const ready = demoForced ? { api: true, subscription: true } : { api: modeFor("api") === "api", subscription: cliReady };
  const status = shellAiStatus({ mode, connection: active, demoForced, cliReady });
  const budget = budgetStatus(ai);
  const cap = formatUsd(budget.dailyCapUsd, locale);
  const limitedUntil = mode === "claude_code" ? subscriptionLimitedUntil() : null;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:flex md:flex-col">
        <div className="px-5 py-5">
          <Link href="/" aria-label={t("homeLink")} className="rounded-md text-lg font-semibold tracking-tight">
            {t("appName")}
          </Link>
          <p className="mt-1 text-xs text-muted">{t("tagline")}</p>
        </div>
        <NavLinks />
        <ConnectionSwitch active={active} ready={ready} className="mt-auto px-5 pb-5" />
      </aside>
      <MobileNav appName={t("appName")} />
      <main className="flex-1 px-4 py-6 md:px-10 md:py-8">
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          <ConnectionSwitch active={active} ready={ready} className="md:hidden" />
          {status === "demo-forced" && <Alert tone="neutral">{t("demoBanner.forced")}</Alert>}
          {status === "demo-api" && <Alert tone="neutral">{t("demoBanner.api")}</Alert>}
          {status === "subscription-paused" && (
            <Alert tone="warning">
              {t("subscriptionPaused")}{" "}
              <Link href="/settings" className="underline">
                {t("subscriptionPausedLink")}
              </Link>
            </Alert>
          )}
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
