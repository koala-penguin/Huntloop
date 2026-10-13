"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldHint, Label, Textarea } from "@/components/ui/form";
import { createSearchAction } from "@/app/search/actions";

/** "What are you looking for?" in your own words (any language). Empty = your saved preferences. */
export function SearchForm() {
  const t = useTranslations("search");
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const result = await createSearchAction(query);
      if (result.ok) router.push(`/search/${result.value.searchId}`);
    });
  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor="search-query">{t("queryLabel")}</Label>
      <Textarea
        id="search-query"
        rows={2}
        value={query}
        disabled={pending}
        onChange={(e) => setQuery(e.target.value)}
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
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Search className="size-4" aria-hidden />}
          {t("submit")}
        </Button>
      </div>
    </div>
  );
}
