"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { CONNECTIONS, type Connection } from "@/shared/ai-settings";
import { setActiveConnectionAction } from "@/app/settings/actions";
import { cn } from "@/lib/cn";

/** Quick switch between the API key and the Claude subscription, from any page. */
export function ConnectionSwitch({ active, ready, className }: { active: Connection; ready: Record<Connection, boolean>; className?: string }) {
  const t = useTranslations("settings.connection");
  const router = useRouter();
  const [pending, start] = useTransition();
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
            onClick={() =>
              active !== connection &&
              start(async () => {
                await setActiveConnectionAction(connection);
                router.refresh();
              })
            }
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
    </div>
  );
}
