"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/form";
import { deleteSearchAction, saveSearchAction, unsaveSearchAction } from "@/app/search/actions";
import type { Connection } from "@/shared/ai-settings";
import { useFieldValue } from "@/components/ui/use-field-value";

/** Save a search (name + optional daily check), change those settings, or delete the search. */
export function SavedSearchControls({ searchId, saved, name, daily, scheduleNote, connection }: { searchId: number; saved: boolean; name: string; daily: boolean; scheduleNote: string | null; connection: Connection }) {
  const t = useTranslations("search.saved");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue, nameInput] = useFieldValue(name);
  const [checkDaily, setCheckDaily] = useState(daily);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const run = (fn: () => Promise<unknown>, after?: () => void) =>
    start(async () => {
      await fn();
      after?.();
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={`search-name-${searchId}`}>{t("name")}</Label>
        <Input ref={nameInput} id={`search-name-${searchId}`} value={value} maxLength={120} onChange={(e) => setValue(e.target.value)} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={checkDaily} onChange={(e) => setCheckDaily(e.target.checked)} />
        <span className="flex flex-col gap-0.5">
          <span>{t("daily")}</span>
          <span className="text-xs text-muted">{t(`dailyHint.${connection}`)}</span>
        </span>
      </label>
      {saved && scheduleNote === "budget" && <Alert>{t("skippedBudget")}</Alert>}
      {saved && scheduleNote === "limit" && <Alert>{t("skippedLimit")}</Alert>}
      {saved && scheduleNote === "cli_login" && <Alert>{t("heldCliLogin")}</Alert>}
      {saved && scheduleNote === "cli_missing" && <Alert>{t("heldCliMissing")}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => run(() => saveSearchAction(searchId, value, checkDaily))}>
          <Bookmark className="size-3.5" aria-hidden />
          {saved ? t("update") : t("save")}
        </Button>
        {saved && (
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => unsaveSearchAction(searchId))}>
            {t("unsave")}
          </Button>
        )}
        {!confirmingDelete && (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmingDelete(true)}>
            <Trash2 className="size-3.5" aria-hidden />
            {t("delete")}
          </Button>
        )}
      </div>
      {confirmingDelete && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {t("deleteConfirm")}
          <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => run(() => deleteSearchAction(searchId), () => router.push("/search"))}>
            <Trash2 className="size-3.5" aria-hidden />
            {t("delete")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmingDelete(false)}>
            {tCommon("cancel")}
          </Button>
        </div>
      )}
    </div>
  );
}
