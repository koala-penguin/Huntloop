"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldHint, Label, Textarea } from "@/components/ui/form";
import { createSearchAction } from "@/app/search/actions";
import { useFieldValue } from "@/components/ui/use-field-value";

/** "What are you looking for?" in your own words (any language). Empty = your saved preferences. */
export function SearchForm() {
  const t = useTranslations("search");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [query, setQuery, queryInput] = useFieldValue<HTMLTextAreaElement>();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const noRef = useRef<HTMLButtonElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const empty = query.trim() === "";
  const run = () =>
    start(async () => {
      const result = await createSearchAction(query);
      if (result.ok) router.push(`/search/${result.value.searchId}`);
    });
  // An empty query searches with the saved preferences: ask first, so it is never a surprise.
  const submit = () => {
    if (pending) return;
    if (empty) setConfirming(true);
    else run();
  };

  // Declining (No / Escape) puts focus back on the search button; Yes leaves it (the button is disabled while searching).
  const decline = () => {
    setConfirming(false);
    submitRef.current?.focus();
  };

  // Focus "No" when the panel opens (an accidental Enter cancels).
  useEffect(() => {
    if (confirming) noRef.current?.focus();
  }, [confirming]);

  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") decline();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming]);
  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="search-query">{t("queryLabel")}</Label>
      <Textarea
        ref={queryInput}
        id="search-query"
        rows={2}
        value={query}
        disabled={pending}
        onChange={(e) => {
          setQuery(e.target.value);
          setConfirming(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={t("queryPlaceholder")}
      />
      <FieldHint>{t("queryHint")}</FieldHint>
      <div>
        <Button ref={submitRef} type="button" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />}
          {empty ? t("submitPreferences") : t("submit")}
        </Button>
      </div>
      {confirming && empty && (
        <div role="alertdialog" aria-labelledby={titleId} className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3 text-sm">
          <p id={titleId} className="font-medium">
            {t("confirmPreferences")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                run();
              }}
            >
              {tCommon("yes")}
            </Button>
            <Button ref={noRef} type="button" variant="ghost" size="sm" disabled={pending} onClick={decline}>
              {tCommon("no")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
