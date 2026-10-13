"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Bookmark, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/form";
import { deleteSearchAction, saveSearchAction, unsaveSearchAction } from "@/app/search/actions";

/** Save a search (name + optional daily check), change those settings, or delete the search. */
export function SavedSearchControls({ searchId, saved, name, daily, scheduleNote }: { searchId: number; saved: boolean; name: string; daily: boolean; scheduleNote: string | null }) {
  const t = useTranslations("search.saved");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(name);
  const [checkDaily, setCheckDaily] = useState(daily);
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
        <Input id={`search-name-${searchId}`} value={value} maxLength={120} onChange={(e) => setValue(e.target.value)} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={checkDaily} onChange={(e) => setCheckDaily(e.target.checked)} />
        <span className="flex flex-col gap-0.5">
          <span>{t("daily")}</span>
          <span className="text-xs text-muted">{t("dailyHint")}</span>
        </span>
      </label>
      {saved && scheduleNote === "budget" && <Alert>{t("skippedBudget")}</Alert>}
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
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => run(() => deleteSearchAction(searchId), () => router.push("/search"))}>
          <Trash2 className="size-3.5" aria-hidden />
          {t("delete")}
        </Button>
      </div>
    </div>
  );
}
