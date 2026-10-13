"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface TaskUserAction {
  kind: string;
  site?: string | null;
}

/**
 * Shown while a task waits for the user: solve the CAPTCHA or sign in inside Huntloop's browser
 * window, then Continue — or skip that site, or stop the task.
 */
export function UserActionPrompt({ taskId, action }: { taskId: number; action: TaskUserAction }) {
  const t = useTranslations("userAction");
  const [sent, setSent] = useState<string | null>(null);
  const send = async (what: "continue" | "skip" | "cancel") => {
    setSent(what);
    await fetch(`/api/tasks/${taskId}`, what === "cancel" ? { method: "DELETE" } : { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: what }) });
  };
  const site = action.site ? t(`site.${["seek", "linkedin"].includes(action.site) ? action.site : "other"}`) : t("site.other");
  const kind = ["captcha", "login", "checkpoint"].includes(action.kind) ? action.kind : "other";
  return (
    <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-soft p-4 text-sm text-warning" role="alert" data-user-action={action.kind}>
      <p className="flex items-center gap-2 font-medium">
        <AlertTriangle className="size-4" aria-hidden />
        {t("title")}
      </p>
      <p>{t(`kind.${kind}`, { site })}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={!!sent} onClick={() => void send("continue")}>
          {t("continue")}
        </Button>
        <Button type="button" variant="secondary" size="sm" disabled={!!sent} onClick={() => void send("skip")}>
          {t("skip", { site })}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={!!sent} onClick={() => void send("cancel")}>
          {t("stop")}
        </Button>
      </div>
    </div>
  );
}
