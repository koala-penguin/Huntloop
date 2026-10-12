"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Plus, RefreshCw, X } from "lucide-react";
import type { SearchFilters } from "@/shared/schemas/search";
import { EMPLOYMENT_TYPES, WORKPLACE_TYPES } from "@/shared/schemas/preferences";
import { SENIORITY_LEVELS } from "@/shared/schemas/profile";
import { Button } from "@/components/ui/button";
import { Badge, Alert } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/form";
import { TagInput } from "@/components/ui/tag-input";
import { CountrySelect } from "@/components/ui/country-select";
import { useCountryNames } from "@/components/i18n/country-names";
import { rerunSearchAction } from "@/app/search/actions";
import { SearchProgress } from "./search-progress";

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** The search's filters as chips, editable in place; "Run again" uses the edited filters. */
export function FilterEditor({ searchId, filters, runningTaskId }: { searchId: number; filters: SearchFilters | null; runningTaskId: number | null }) {
  const t = useTranslations("search.filters");
  const tPref = useTranslations("preferences");
  const tSearch = useTranslations("search");
  const countryNames = useCountryNames();
  const locale = useLocale();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<SearchFilters | null>(filters);
  const [taskId, setTaskId] = useState<number | null>(runningTaskId);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = (withFilters: SearchFilters | null) =>
    start(async () => {
      const result = await rerunSearchAction(searchId, withFilters);
      if (!result.ok) setError(result.error);
      else {
        setEditing(false);
        setTaskId(result.value.taskId);
        router.refresh();
      }
    });

  if (taskId) return <SearchProgress key={taskId} taskId={taskId} />;
  if (!filters || !draft) return null;

  const place = (l: SearchFilters["locations"][number]) => [l.city, countryNames.name(l.country)].filter(Boolean).join(", ");

  if (!editing) {
    const chips = [
      ...filters.titles,
      ...filters.keywords.map((k) => `+ ${k}`),
      ...filters.locations.map(place),
      ...filters.workplace.map((w) => tPref(`workplaceType.${w}`)),
      ...filters.employmentTypes.map((e) => tPref(`employmentType.${e}`)),
      ...filters.seniority.map((s) => tPref(`seniorityValue.${s}`)),
      ...(filters.salaryMin ? [t("salaryChip", { amount: new Intl.NumberFormat(locale).format(filters.salaryMin) })] : []),
      ...(filters.postedWithinDays ? [t("postedChip", { days: filters.postedWithinDays })] : []),
      ...filters.excludeKeywords.map((k) => `− ${k}`),
    ];
    return (
      <div className="flex flex-col gap-3">
        <ul className="flex flex-wrap gap-1.5" aria-label={t("label")}>
          {chips.map((chip, i) => (
            <li key={`${chip}-${i}`}>
              <Badge tone="outline">{chip}</Badge>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            {t("edit")}
          </Button>
          <Button type="button" size="sm" disabled={pending} onClick={() => run(null)}>
            {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
            {tSearch("runAgain")}
          </Button>
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    );
  }

  const set = (patch: Partial<SearchFilters>) => setDraft({ ...draft, ...patch });
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="f-titles">{t("titles")}</Label>
          <TagInput id="f-titles" value={draft.titles} onChange={(titles) => set({ titles })} removeLabel={(tag) => t("remove", { item: tag })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="f-keywords">{t("keywords")}</Label>
          <TagInput id="f-keywords" value={draft.keywords} onChange={(keywords) => set({ keywords })} removeLabel={(tag) => t("remove", { item: tag })} />
        </div>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("locations")}</legend>
        {draft.locations.map((l, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <CountrySelect
              aria-label={t("country")}
              value={l.country}
              onChange={(country) => set({ locations: draft.locations.map((x, j) => (j === i ? { ...x, country: country ?? x.country } : x)) })}
              className="w-auto"
            />
            <Input
              aria-label={t("city")}
              value={l.city ?? ""}
              placeholder={t("anyCity")}
              onChange={(e) => set({ locations: draft.locations.map((x, j) => (j === i ? { ...x, city: e.target.value || null } : x)) })}
              className="w-48"
            />
            <Button type="button" variant="ghost" size="sm" aria-label={t("remove", { item: place(l) })} onClick={() => set({ locations: draft.locations.filter((_, j) => j !== i) })}>
              <X className="size-3.5" aria-hidden />
            </Button>
          </div>
        ))}
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => set({ locations: [...draft.locations, { country: draft.locations[0]?.country ?? "AU", city: null }] })}>
            <Plus className="size-3.5" aria-hidden />
            {t("addLocation")}
          </Button>
        </div>
      </fieldset>

      <div className="grid gap-4 md:grid-cols-3">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-medium">{t("workplace")}</legend>
          {WORKPLACE_TYPES.map((w) => (
            <label key={w} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.workplace.includes(w)} onChange={() => set({ workplace: toggle(draft.workplace, w) })} />
              {tPref(`workplaceType.${w}`)}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-medium">{t("employmentTypes")}</legend>
          {EMPLOYMENT_TYPES.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.employmentTypes.includes(e)} onChange={() => set({ employmentTypes: toggle(draft.employmentTypes, e) })} />
              {tPref(`employmentType.${e}`)}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-sm font-medium">{t("seniority")}</legend>
          {SENIORITY_LEVELS.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.seniority.includes(s)} onChange={() => set({ seniority: toggle(draft.seniority, s) })} />
              {tPref(`seniorityValue.${s}`)}
            </label>
          ))}
        </fieldset>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="f-salary">{t("salaryMin")}</Label>
          <Input id="f-salary" type="number" min={0} value={draft.salaryMin ?? ""} onChange={(e) => set({ salaryMin: e.target.value ? Number(e.target.value) : null })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="f-days">{t("postedWithinDays")}</Label>
          <Input id="f-days" type="number" min={1} max={120} value={draft.postedWithinDays ?? ""} onChange={(e) => set({ postedWithinDays: e.target.value ? Number(e.target.value) : null })} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="f-exclude">{t("excludeKeywords")}</Label>
          <TagInput id="f-exclude" value={draft.excludeKeywords} onChange={(excludeKeywords) => set({ excludeKeywords })} removeLabel={(tag) => t("remove", { item: tag })} />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => run(draft)}>
          {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
          {t("saveAndRun")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(filters);
            setEditing(false);
          }}
        >
          {t("cancel")}
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
