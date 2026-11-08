"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { CONNECTIONS, needsDemoConfirm, type Connection } from "@/shared/ai-settings";
import { setActiveConnectionAction } from "@/app/settings/actions";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** Quick switch between the API key and the Claude subscription, from any page. */
export function ConnectionSwitch({ active, ready, className }: { active: Connection; ready: Record<Connection, boolean>; className?: string }) {
  const t = useTranslations("settings.connection");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  // A connection that isn't ready would put the whole app in demo mode: ask first.
  const [confirming, setConfirming] = useState<Connection | null>(null);
  const switchTo = (connection: Connection) =>
    start(async () => {
      await setActiveConnectionAction(connection);
      setConfirming(null);
      router.refresh();
    });
  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <p id="connection-switch-label" className="text-xs text-muted">
        {t("switchLabel")}
      </p>
      <div role="group" aria-labelledby="connection-switch-label" className="flex rounded-md border border-border p-0.5 text-xs">
        {CONNECTIONS.map((connection) => (
          <button
            key={connection}
            type="button"
            aria-pressed={active === connection}
            disabled={pending}
            title={ready[connection] ? undefined : t(`notReadyShort.${connection}`)}
            onClick={() => {
              if (active === connection) return;
              if (needsDemoConfirm(connection, active, ready)) setConfirming(connection);
              else switchTo(connection);
            }}
            className={cn(
              "flex-1 rounded px-2 py-1",
              active === connection ? "bg-accent text-accent-foreground" : "text-muted hover:bg-accent-soft hover:text-foreground",
              !ready[connection] && active !== connection && "opacity-70",
            )}
          >
            {t(`${connection}.short`)}
          </button>
        ))}
      </div>
      {confirming && confirming !== active && (
        <div role="alertdialog" aria-label={t(`${confirming}.short`)} className="mt-1 flex flex-col gap-2 rounded-md border border-border p-2 text-xs">
          <p>{t(`demoConfirm.${confirming}`)}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => switchTo(confirming)}>
              {t("demoConfirmSwitch")}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(null)}>
              {tCommon("cancel")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
