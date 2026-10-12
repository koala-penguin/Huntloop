"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import {
  EMPLOYMENT_TYPES,
  SALARY_BASES,
  SALARY_PERIODS,
  WORKPLACE_TYPES,
  type Preferences,
} from "@/shared/schemas/preferences";
import { SENIORITY_LEVELS } from "@/shared/schemas/profile";
import { marketPack } from "@/shared/markets";
import { useCountryNames } from "@/components/i18n/country-names";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Select, Textarea } from "@/components/ui/form";
import { TagInput } from "@/components/ui/tag-input";
import { CountrySelect } from "@/components/ui/country-select";
import { savePreferencesAction } from "@/app/profile/actions";

function CheckboxGroup<T extends string>({ values, selected, label, onChange }: { values: readonly T[]; selected: T[]; label: (v: T) => string; onChange: (next: T[]) => void }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-2">
      {values.map((v) => (
        <label key={v} className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={selected.includes(v)} onChange={(e) => onChange(e.target.checked ? [...selected, v] : selected.filter((s) => s !== v))} />
          {label(v)}
        </label>
      ))}
    </div>
  );
}

function Group({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      {children}
      {hint && <FieldHint>{hint}</FieldHint>}
    </fieldset>
  );
}

export function PreferencesEditor({ initial }: { initial: Preferences }) {
  const t = useTranslations("preferences");
  const tProfile = useTranslations("profile");
  const tCommon = useTranslations("common");
  const { name: countryNameOf } = useCountryNames();
  const router = useRouter();
  const [prefs, setPrefs] = useState<Preferences>(initial);
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string }>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const removeLabel = (tag: string) => tProfile("removeItem", { item: tag });

  const update = (fn: (p: Preferences) => Preferences) => {
    setPrefs(fn);
    setStatus({ kind: "idle" });
  };

  const save = () =>
    startTransition(async () => {
      const result = await savePreferencesAction(prefs);
      if (result.ok) {
        setStatus({ kind: "saved" });
        router.refresh();
      } else setStatus({ kind: "error", message: result.error });
    });

  const usedCountries = prefs.markets.map((m) => m.country);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("rolesTitle")}</CardTitle>
          <CardDescription>{t("rolesDescription")}</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-5">
          <Group label={t("targetTitles")} hint={t("targetTitlesHint")}>
            <TagInput value={prefs.targetTitles} removeLabel={removeLabel} placeholder={t("targetTitlesPlaceholder")} onChange={(targetTitles) => update((p) => ({ ...p, targetTitles }))} aria-label={t("targetTitles")} />
          </Group>
          <Group label={t("seniority")}>
            <CheckboxGroup values={SENIORITY_LEVELS} selected={prefs.seniority} label={(v) => t(`seniorityValue.${v}`)} onChange={(seniority) => update((p) => ({ ...p, seniority }))} />
          </Group>
          <Group label={t("employmentTypes")}>
            <CheckboxGroup values={EMPLOYMENT_TYPES} selected={prefs.employmentTypes} label={(v) => t(`employmentType.${v}`)} onChange={(employmentTypes) => update((p) => ({ ...p, employmentTypes }))} />
          </Group>
          <Group label={t("workplace")}>
            <CheckboxGroup values={WORKPLACE_TYPES} selected={prefs.workplace} label={(v) => t(`workplaceType.${v}`)} onChange={(workplace) => update((p) => ({ ...p, workplace }))} />
          </Group>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("marketsTitle")}</CardTitle>
          <CardDescription>{t("marketsDescription")}</CardDescription>
        </CardHeader>
        <ul className="flex flex-col gap-4">
          {prefs.markets.map((market, index) => {
            const pack = marketPack(market.country);
            const floor = prefs.salaryFloors.find((f) => f.country === market.country);
            const setMarket = (patch: Partial<typeof market>) =>
              update((p) => ({ ...p, markets: p.markets.map((m, i) => (i === index ? { ...m, ...patch } : patch.primary ? { ...m, primary: false } : m)) }));
            const setFloor = (patch: Partial<NonNullable<typeof floor>> | null) =>
              update((p) => {
                const others = p.salaryFloors.filter((f) => f.country !== market.country);
                if (patch === null) return { ...p, salaryFloors: others };
                const base = floor ?? { country: market.country, amount: 0, currency: pack.currency, period: pack.salaryPeriod, basis: pack.salaryBasisHint ?? "base" };
                return { ...p, salaryFloors: [...others, { ...base, ...patch }] };
              });
            return (
              <li key={market.country} className="flex flex-col gap-3 rounded-md border border-border p-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="font-medium">{countryNameOf(market.country)}</p>
                  <div className="flex items-center gap-4">
                    <label className="flex items-center gap-1.5 text-sm">
                      <input type="radio" name="primary-market" checked={market.primary} onChange={() => setMarket({ primary: true })} />
                      {t("primaryMarket")}
                    </label>
                    <label className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={market.remoteOk} onChange={(e) => setMarket({ remoteOk: e.target.checked })} />
                      {t("remoteOk")}
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={tProfile("remove")}
                      disabled={prefs.markets.length === 1}
                      onClick={() =>
                        update((p) => {
                          const markets = p.markets.filter((_, i) => i !== index);
                          if (markets.length && !markets.some((m) => m.primary)) markets[0] = { ...markets[0], primary: true };
                          return { ...p, markets, salaryFloors: p.salaryFloors.filter((f) => f.country !== market.country) };
                        })
                      }
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                </div>
                <Group label={t("cities")} hint={t("citiesHint")}>
                  <TagInput value={market.cities} suggestions={pack.suggestedCities} removeLabel={removeLabel} onChange={(cities) => setMarket({ cities })} aria-label={t("cities")} />
                </Group>
                <Group label={t("salaryFloor")} hint={t("salaryFloorHint")}>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Input
                      type="number"
                      min={0}
                      aria-label={t("amount")}
                      placeholder={t("amount")}
                      value={floor?.amount ?? ""}
                      onChange={(e) => (e.target.value === "" ? setFloor(null) : setFloor({ amount: Number(e.target.value) }))}
                    />
                    <Input aria-label={t("currency")} value={floor?.currency ?? pack.currency} disabled={!floor} onChange={(e) => setFloor({ currency: e.target.value.toUpperCase().slice(0, 3) })} />
                    <Select aria-label={t("period")} value={floor?.period ?? pack.salaryPeriod} disabled={!floor} onChange={(e) => setFloor({ period: e.target.value as (typeof SALARY_PERIODS)[number] })}>
                      {SALARY_PERIODS.map((period) => (
                        <option key={period} value={period}>
                          {t(`periodValue.${period}`)}
                        </option>
                      ))}
                    </Select>
                    <Select aria-label={t("basis")} value={floor?.basis ?? pack.salaryBasisHint ?? "base"} disabled={!floor} onChange={(e) => setFloor({ basis: e.target.value as (typeof SALARY_BASES)[number] })}>
                      {SALARY_BASES.map((basis) => (
                        <option key={basis} value={basis}>
                          {t(`basisValue.${basis}`)}
                        </option>
                      ))}
                    </Select>
                  </div>
                </Group>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 max-w-sm">
          <CountrySelect
            aria-label={t("addMarket")}
            value={null}
            emptyLabel={t("addMarket")}
            exclude={usedCountries}
            onChange={(code) => code && update((p) => ({ ...p, markets: [...p.markets, { country: code, primary: p.markets.length === 0, cities: [], remoteOk: true }] }))}
          />
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("otherTitle")}</CardTitle>
        </CardHeader>
        <div className="flex flex-col gap-5">
          <Group label={t("excludedCompanies")} hint={t("excludedCompaniesHint")}>
            <TagInput value={prefs.excludedCompanies} removeLabel={removeLabel} onChange={(excludedCompanies) => update((p) => ({ ...p, excludedCompanies }))} aria-label={t("excludedCompanies")} />
          </Group>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={prefs.willingToRelocate} onChange={(e) => update((p) => ({ ...p, willingToRelocate: e.target.checked }))} />
            {t("willingToRelocate")}
          </label>
          <Group label={t("maxPostingAge")} hint={t("maxPostingAgeHint")}>
            <Input
              type="number"
              min={1}
              max={365}
              className="max-w-32"
              aria-label={t("maxPostingAge")}
              value={prefs.maxPostingAgeDays}
              onChange={(e) => update((p) => ({ ...p, maxPostingAgeDays: Math.min(365, Math.max(1, Number(e.target.value) || 30)) }))}
            />
          </Group>
          <Group label={t("notes")} hint={t("notesHint")}>
            <Textarea rows={3} aria-label={t("notes")} value={prefs.notes} onChange={(e) => update((p) => ({ ...p, notes: e.target.value }))} />
          </Group>
        </div>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex items-center gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-lg md:border">
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? tCommon("saving") : t("save")}
        </Button>
        {status.kind === "saved" && <span className="text-sm text-accent">{tCommon("saved")}</span>}
        {status.kind === "error" && <span className="text-sm text-danger">{tCommon("saveFailed", { message: status.message })}</span>}
      </div>
    </div>
  );
}
