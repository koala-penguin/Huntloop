"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import type { Connection } from "@/shared/ai-settings";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { checkClaudeCodeAction, setActiveConnectionAction, type ClaudeCodeView } from "@/app/settings/actions";

interface Props {
  active: Connection;
  apiKeySet: boolean;
  cli: ClaudeCodeView;
  /** HUNTLOOP_AI=fake: everything is simulated whatever is chosen. */
  demoForced: boolean;
}

/** Choose how Huntloop reaches Claude: an API key (billed per token) or the user's own Claude subscription via Claude Code. */
export function ConnectionSettings({ active, apiKeySet, cli: initialCli, demoForced }: Props) {
  const t = useTranslations("settings.connection");
  const router = useRouter();
  const [cli, setCli] = useState(initialCli);
  const [current, setCurrent] = useState(active);
  const [switching, startSwitch] = useTransition();
  const [checking, startCheck] = useTransition();

  const use = (connection: Connection) =>
    startSwitch(async () => {
      const result = await setActiveConnectionAction(connection);
      if (result.ok) {
        setCurrent(result.config.active);
        router.refresh();
      }
    });

  const ready: Record<Connection, boolean> = { api: apiKeySet, subscription: cli.found && cli.loggedIn };
  const cliState = !cli.found ? "notInstalled" : !cli.loggedIn ? "signedOut" : "signedIn";

  const option = (connection: Connection, body: React.ReactNode) => (
    <section
      aria-labelledby={`connection-${connection}`}
      data-connection={connection}
      className={cn("flex flex-col gap-3 rounded-lg border p-4", current === connection ? "border-accent bg-accent-soft/40" : "border-border")}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`connection-${connection}`} className="font-medium">
          {t(`${connection}.title`)}
        </h3>
        {current === connection ? (
          <Badge tone="neutral">{t("inUse")}</Badge>
        ) : (
          <Button type="button" size="sm" variant="secondary" disabled={switching} onClick={() => use(connection)}>
            {t("useThis")}
          </Button>
        )}
      </div>
      {body}
    </section>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <div className="grid gap-4 md:grid-cols-2">
        {option(
          "api",
          <>
            <p className="text-sm text-muted">{t("api.body")}</p>
            <p className="text-sm">
              <Badge tone={apiKeySet ? "neutral" : "warning"}>{apiKeySet ? t("api.keySet") : t("api.keyMissing")}</Badge>
            </p>
            {!apiKeySet && <p className="text-xs text-muted">{t("api.howTo")}</p>}
            <p className="text-xs text-muted">{t("api.credits")}</p>
          </>,
        )}
        {option(
          "subscription",
          <>
            <p className="text-sm text-muted">{t("subscription.body")}</p>
            <div className="flex flex-wrap items-center gap-2 text-sm" data-cli-state={cliState}>
              <Badge tone={cliState === "signedIn" ? "neutral" : "warning"}>{t(`subscription.${cliState}`)}</Badge>
              {cli.version && <span className="text-xs text-muted">{t("subscription.version", { version: cli.version })}</span>}
              <Button type="button" size="sm" variant="ghost" disabled={checking} onClick={() => startCheck(async () => setCli(await checkClaudeCodeAction()))}>
                {checking ? t("subscription.checking") : t("subscription.checkAgain")}
              </Button>
            </div>
            {cliState !== "signedIn" && (
              <ol className="list-decimal pl-5 text-xs text-muted">
                {cliState === "notInstalled" && (
                  <li>
                    {t("subscription.install")} <code className="rounded bg-accent-soft px-1">{t("subscription.installCommand")}</code>
                  </li>
                )}
                <li>
                  {t("subscription.login")} <code className="rounded bg-accent-soft px-1">{t("subscription.loginCommand")}</code>
                </li>
                <li>{t("subscription.thenCheck")}</li>
              </ol>
            )}
            {cli.consoleSignIn && <p className="text-xs text-warning">{t("subscription.consoleSignIn")}</p>}
            <p className="text-xs text-muted">{t("subscription.privacy")}</p>
          </>,
        )}
      </div>
      {demoForced ? (
        <Alert tone="neutral" className="mt-4">
          {t("demoForced")}
        </Alert>
      ) : (
        !ready[current] && (
          <Alert tone="warning" className="mt-4">
            {t(`notReady.${current}`)}
          </Alert>
        )
      )}
    </Card>
  );
}
