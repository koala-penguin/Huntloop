"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";
import { ArrowRight, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { FieldHint, Input, Label, Select } from "@/components/ui/form";
import { TagInput } from "@/components/ui/tag-input";
import { CountrySelect } from "@/components/ui/country-select";
import { LanguageCombobox } from "@/components/ui/language-combobox";
import { MonthField } from "@/components/ui/month-field";
import { marketPack } from "@/shared/markets";
import { EMPLOYMENT_TYPES, WORKPLACE_TYPES } from "@/shared/schemas/preferences";
import { LANGUAGE_LEVELS, SENIORITY_LEVELS, type WorkRight } from "@/shared/schemas/profile";
import { CV_LANGUAGES } from "@/shared/schemas/cv";
import { CURRENT_STATUSES, CV_BUILDER_DEPTHS, CV_BUILDER_PERSONAS, ROLE_DEPTHS, type FormCardValue, type CvBuilderForm, type RoleCard } from "@/shared/schemas/cv-builder";
import { startCvBuilderAction } from "@/app/profile/cv-builder/actions";

/**
 * The fields of the CV builder's steps, as controlled groups: a card in the chat and the "On file"
 * editor under it show the same ones. Plus the setup step, which is picks only.
 */

/** What to mark on a group's fields, by path ("titles", "roles.1.start"): values to check, and values that stopped a save. */
export interface FieldFlags {
  inferred: string[];
  invalid: string[];
}
const NO_FLAGS: FieldFlags = { inferred: [], invalid: [] };

/** Keeps field ids apart when two editors with the same labels are on one page (a card and "On file"). */
export const FieldScope = createContext("");

interface FieldAria {
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export function Field({
  label,
  hint,
  children,
  className,
  uid,
  check = false,
  error,
}: {
  label: string;
  hint?: string;
  children: (id: string, aria: FieldAria) => ReactNode;
  className?: string;
  uid?: string;
  /** The value was read from the candidate's words, not picked: ask them to look at it. */
  check?: boolean;
  error?: string | null;
}) {
  const t = useTranslations("chat.card");
  const scope = useContext(FieldScope);
  const id = `${scope}f-${label.replace(/\W+/g, "-").toLowerCase()}${uid ? `-${uid}` : ""}`;
  const notes = [check ? `${id}-check` : null, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 ${className ?? ""}`}>
      <span className="flex items-center gap-2">
        <Label htmlFor={id} id={`${id}-label`}>
          {label}
        </Label>
        {check && (
          <Badge tone="outline" id={`${id}-check`}>
            {t("formCheck")}
          </Badge>
        )}
      </span>
      {children(id, {
        ...(notes ? { "aria-describedby": notes } : {}),
        ...(error ? { "aria-invalid": true as const } : {}),
      })}
      {error && (
        <p id={`${id}-error`} className="text-xs text-danger">
          {error}
        </p>
      )}
      {hint && <FieldHint>{hint}</FieldHint>}
    </div>
  );
}

export function Checks<T extends string>({
  legend,
  values,
  selected,
  label,
  onChange,
  check = false,
}: {
  legend: string;
  values: readonly T[];
  selected: T[];
  label: (v: T) => string;
  onChange: (next: T[]) => void;
  check?: boolean;
}) {
  const t = useTranslations("chat.card");
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 flex items-center gap-2 text-sm font-medium">
        {legend}
        {check && <Badge tone="outline">{t("formCheck")}</Badge>}
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {values.map((v) => (
          <label key={v} className="flex min-h-8 items-center gap-1.5 text-sm">
            <input type="checkbox" checked={selected.includes(v)} onChange={(e) => onChange(e.target.checked ? [...selected, v] : selected.filter((s) => s !== v))} />
            {label(v)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The text shown under a field that stopped a save. */
function useFieldError(flags: FieldFlags) {
  const t = useTranslations("cvBuilder");
  return (path: string, kind = "generic"): string | null => (flags.invalid.includes(path) ? t(`fieldError.${kind}`) : null);
}

type Setup = FormCardValue<"setup">;

/** The picks that shape the CV-builder session: its language, the market and how deep to go. */
function SetupPicks({ value: setup, onChange }: { value: Setup; onChange: (next: Setup) => void }) {
  const t = useTranslations("cvBuilder");
  const scope = useContext(FieldScope);
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("setup.language")}>
          {(id) => (
            <Select id={id} className="h-10" value={setup.language} onChange={(e) => onChange({ ...setup, language: e.target.value as Setup["language"] })}>
              {CV_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t(`languageName.${l}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("setup.country")} hint={t("setup.countryHint")}>
          {(id) => <CountrySelect id={id} className="h-10" value={setup.country} onChange={(country) => country && onChange({ ...setup, country })} />}
        </Field>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("setup.depth")}</legend>
        {CV_BUILDER_DEPTHS.map((d) => (
          <label key={d} className="flex items-start gap-2 text-sm">
            <input type="radio" name={`${scope}depth`} className="mt-1" checked={setup.depth === d} onChange={() => onChange({ ...setup, depth: d })} />
            <span>
              <span className="font-medium">{t(`depth.${d}`)}</span> <span className="text-muted">{t(`depthHint.${d}`)}</span>
            </span>
          </label>
        ))}
        <FieldHint>{t("setup.costHint")}</FieldHint>
      </fieldset>
    </>
  );
}

/**
 * What describes the candidate (any number, or none), and with `picks` the CV builder's language,
 * market and depth too. A card from the chat shows only the descriptions; "On file" shows all of it.
 */
export function SetupFields({ value, onChange, flags = NO_FLAGS, picks }: { value: Setup; onChange: (next: Setup) => void; flags?: FieldFlags; picks: boolean }) {
  const t = useTranslations("cvBuilder");
  return (
    <div className="flex flex-col gap-5">
      <Checks legend={t("setup.personas")} values={CV_BUILDER_PERSONAS} selected={value.personas} label={(v) => t(`persona.${v}`)} check={flags.inferred.includes("personas")} onChange={(personas) => onChange({ ...value, personas })} />
      {picks && <SetupPicks value={value} onChange={onChange} />}
    </div>
  );
}

/**
 * Before the CV-builder session exists: its language, the market and how deep to go, asked as one question
 * with the picks under it. Starting it leads to a short chat about the candidate's situation.
 */
export function SetupForm({ initial }: { initial: CvBuilderForm["setup"] }) {
  const t = useTranslations("cvBuilder");
  const router = useRouter();
  const [setup, setSetup] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const begin = () =>
    start(async () => {
      const result = await startCvBuilderAction(setup);
      if (!result.ok) setError(result.error);
      else {
        router.push("/profile/cv-builder");
        router.refresh();
      }
    });
  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1" data-role="assistant">
        <h2 className="text-lg font-semibold">{t("setup.title")}</h2>
        <p className="text-sm leading-relaxed">{t("setup.ask")}</p>
      </div>
      <div className="flex flex-col gap-5 rounded-md border border-border p-3" role="group" aria-label={t("setup.title")}>
        <SetupPicks value={setup} onChange={setSetup} />
        {error && <Alert tone="danger">{t("invalidForm")}</Alert>}
        <div>
          <Button type="button" disabled={pending} onClick={begin}>
            <ArrowRight className="size-4" aria-hidden />
            {t("setup.start")}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function WorkRightSelect({ country, value, onChange }: { country: string; value: WorkRight[]; onChange: (next: WorkRight[]) => void }) {
  const t = useTranslations("cvBuilder");
  const tMarkets = useTranslations("markets");
  const pack = marketPack(country);
  const entry = value.find((w) => w.country === country);
  const selected = entry ? (entry.status === "unknown" ? "unknown" : (entry.option ?? "")) : "";
  const set = (optionId: string) => {
    const rest = value.filter((w) => w.country !== country);
    if (!optionId) return onChange(rest);
    const option = pack.workRightOptions.find((o) => o.id === optionId);
    onChange([
      ...rest,
      {
        country,
        status: optionId === "unknown" ? "unknown" : (option?.status ?? "unknown"),
        option: optionId === "unknown" ? null : optionId,
        expires: null,
        note: null,
      },
    ]);
  };
  return (
    <Field label={t("target.workRights")}>
      {(id) => (
        <Select id={id} className="h-10" value={selected} onChange={(e) => set(e.target.value)}>
          <option value="">{t("notSet")}</option>
          {pack.workRightOptions.map((o) => (
            <option key={o.id} value={o.id}>
              {tMarkets(`workRights.${o.id}`)}
            </option>
          ))}
          <option value="unknown">{tMarkets("workRights.unknown")}</option>
        </Select>
      )}
    </Field>
  );
}

type Target = FormCardValue<"target">;

/** The job they're after, in the target market. */
export function TargetFields({ value: target, onChange, country, flags = NO_FLAGS }: { value: Target; onChange: (next: Target) => void; country: string; flags?: FieldFlags }) {
  const t = useTranslations("cvBuilder");
  const tPrefs = useTranslations("preferences");
  const tProfile = useTranslations("profile");
  const error = useFieldError(flags);
  const removeLabel = (tag: string) => tProfile("removeItem", { item: tag });
  const levels = marketPack(country).clearanceLevels;
  const clearance = target.clearances.find((c) => c.country === country)?.level ?? "";
  const checked = (path: string) => flags.inferred.includes(path);
  // The card stays short: the job titles, where, and the right to work. The rest opens on request,
  // or by itself when something in it was read from the candidate's words and needs a look.
  const more = ["seniority", "workplace", "employmentTypes"].some(checked) || target.industries.length > 0 || !!target.availability;
  return (
    <div className="flex flex-col gap-5">
      <Field label={tPrefs("targetTitles")} hint={tPrefs("targetTitlesHint")} error={error("titles", "targetTitle")}>
        {(id) => <TagInput id={id} value={target.titles} removeLabel={removeLabel} placeholder={tPrefs("targetTitlesPlaceholder")} onChange={(titles) => onChange({ ...target, titles })} />}
      </Field>
      <Field label={tPrefs("cities")} hint={tPrefs("citiesHint")}>
        {(id) => <TagInput id={id} value={target.cities} removeLabel={removeLabel} suggestions={marketPack(country).suggestedCities} onChange={(cities) => onChange({ ...target, cities })} />}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <WorkRightSelect country={country} value={target.workRights} onChange={(workRights) => onChange({ ...target, workRights })} />
        {levels.length > 0 && (
          <Field label={t("target.clearance")}>
            {(id) => (
              <Select
                id={id}
                className="h-10"
                value={clearance}
                onChange={(e) =>
                  onChange({
                    ...target,
                    clearances: [
                      ...target.clearances.filter((c) => c.country !== country),
                      ...(e.target.value
                        ? [
                            {
                              country,
                              level: e.target.value,
                              status: "active" as const,
                            },
                          ]
                        : []),
                    ],
                  })
                }
              >
                <option value="">{t("notSet")}</option>
                {levels.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <details className="rounded-md border border-border" open={more || undefined}>
        <summary className="flex min-h-10 cursor-pointer items-center px-3 text-sm font-medium">{t("target.more")}</summary>
        <div className="flex flex-col gap-5 p-3 pt-1">
          <Checks
            legend={tPrefs("seniority")}
            values={SENIORITY_LEVELS}
            selected={target.seniority}
            label={(v) => tPrefs(`seniorityValue.${v}`)}
            check={checked("seniority")}
            onChange={(seniority) => onChange({ ...target, seniority })}
          />
          <Field label={t("target.industries")}>
            {(id) => <TagInput id={id} value={target.industries} removeLabel={removeLabel} onChange={(industries) => onChange({ ...target, industries })} />}
          </Field>
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="checkbox" checked={target.remoteOk} onChange={(e) => onChange({ ...target, remoteOk: e.target.checked })} />
            {tPrefs("remoteOk")}
          </label>
          <Checks
            legend={tPrefs("workplace")}
            values={WORKPLACE_TYPES}
            selected={target.workplace}
            label={(v) => tPrefs(`workplaceType.${v}`)}
            check={checked("workplace")}
            onChange={(workplace) => onChange({ ...target, workplace })}
          />
          <Checks
            legend={tPrefs("employmentTypes")}
            values={EMPLOYMENT_TYPES}
            selected={target.employmentTypes}
            label={(v) => tPrefs(`employmentType.${v}`)}
            check={checked("employmentTypes")}
            onChange={(employmentTypes) => onChange({ ...target, employmentTypes })}
          />
          <label className="flex min-h-8 items-center gap-2 text-sm">
            <input type="checkbox" checked={target.willingToRelocate} onChange={(e) => onChange({ ...target, willingToRelocate: e.target.checked })} />
            {tPrefs("willingToRelocate")}
          </label>
          <Field label={t("target.availability")} hint={t("target.availabilityHint")}>
            {(id) => <Input id={id} className="h-10" value={target.availability} maxLength={200} onChange={(e) => onChange({ ...target, availability: e.target.value })} />}
          </Field>
        </div>
      </details>
    </div>
  );
}

type Current = FormCardValue<"current">;

/** Where they are now: status, job, employer and when it started. */
export function CurrentFields({ value: current, onChange, flags = NO_FLAGS }: { value: Current; onChange: (next: Current) => void; flags?: FieldFlags }) {
  const t = useTranslations("cvBuilder");
  const scope = useContext(FieldScope);
  const error = useFieldError(flags);
  const working = current.status === "employed" || current.status === "self_employed";
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t("current.status")} check={flags.inferred.includes("status")}>
        {(id, aria) => (
          <Select
            id={id}
            className="h-10"
            {...aria}
            value={current.status}
            onChange={(e) =>
              onChange({
                ...current,
                status: e.target.value as Current["status"],
              })
            }
          >
            {CURRENT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`currentStatus.${s}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={working ? t("current.titleNow") : t("current.titleLast")} error={error("title", "title")}>
        {(id, aria) => <Input id={id} className="h-10" {...aria} value={current.title} maxLength={120} onChange={(e) => onChange({ ...current, title: e.target.value })} />}
      </Field>
      <Field label={t("roles.company")}>{(id) => <Input id={id} className="h-10" value={current.company} maxLength={120} onChange={(e) => onChange({ ...current, company: e.target.value })} />}</Field>
      <MonthField legend={t("roles.start")} idPrefix={`${scope}current-start`} value={current.start} invalid={flags.invalid.includes("start")} onChange={(start) => onChange({ ...current, start })} />
      <Field label={t("roles.country")}>
        {(id) => <CountrySelect id={id} className="h-10" value={current.country || null} emptyLabel={t("notSet")} onChange={(country) => onChange({ ...current, country: country ?? "" })} />}
      </Field>
    </div>
  );
}

/** A placeholder id for a row added here; the server gives it its real "exp-N" on save. */
const newRowId = (roles: RoleCard[]) => `new-${roles.length}${Date.now().toString(36)}`;

/** Roles, one group of fields each. Ids stay fixed so answers stay with their role. */
export function RoleRows({ value: roles, onChange, quick, flags = NO_FLAGS }: { value: RoleCard[]; onChange: (next: RoleCard[]) => void; quick: boolean; flags?: FieldFlags }) {
  const t = useTranslations("cvBuilder");
  const tPrefs = useTranslations("preferences");
  const scope = useContext(FieldScope);
  const error = useFieldError(flags);
  const set = (i: number, patch: Partial<RoleCard>) => onChange(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () =>
    onChange([
      ...roles,
      {
        id: newRowId(roles),
        title: "",
        company: "",
        industry: "",
        location: "",
        country: "",
        start: "",
        end: "",
        current: false,
        employmentType: "full_time",
        seniority: null,
        depth: quick && roles.length ? "brief" : "deep",
      },
    ]);
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-4">
        {roles.map((r, i) => {
          const n = i + 1;
          const at = (name: string) => `roles.${i}.${name}`;
          const endError = flags.invalid.includes(at("order")) ? t("fieldError.order") : flags.invalid.includes(at("end")) ? t("fieldError.end") : null;
          return (
            <li key={r.id} data-role-row={r.id}>
              <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm font-medium">{t("roles.rowLegend", { n })}</legend>
                <Field label={t("roles.roleTitle", { n })} error={error(at("title"), "title")}>
                  {(id, aria) => <Input id={id} className="h-10" {...aria} aria-required value={r.title} maxLength={120} onChange={(e) => set(i, { title: e.target.value })} />}
                </Field>
                <Field label={t("roles.companyN", { n })}>{(id) => <Input id={id} className="h-10" value={r.company} maxLength={120} onChange={(e) => set(i, { company: e.target.value })} />}</Field>
                <div className="flex flex-col gap-1.5">
                  <MonthField
                    legend={t("roles.startN", { n })}
                    idPrefix={`${scope}${r.id}-start`}
                    required
                    value={r.start}
                    invalid={flags.invalid.includes(at("start"))}
                    describedBy={flags.invalid.includes(at("start")) ? `${scope}${r.id}-start-error` : undefined}
                    onChange={(start) => set(i, { start })}
                  />
                  {flags.invalid.includes(at("start")) && (
                    <p id={`${scope}${r.id}-start-error`} className="text-xs text-danger">
                      {t("fieldError.start")}
                    </p>
                  )}
                </div>
                <div className="flex flex-col gap-1.5">
                  <MonthField
                    // Unticking "I still work here" starts the end date empty again.
                    key={r.current ? "current" : "ended"}
                    legend={t("roles.endN", { n })}
                    idPrefix={`${scope}${r.id}-end`}
                    value={r.end}
                    disabled={r.current}
                    invalid={!!endError}
                    describedBy={endError ? `${scope}${r.id}-end-error` : undefined}
                    onChange={(end) => set(i, { end })}
                  />
                  <label className="flex min-h-8 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={r.current}
                      aria-label={t("roles.stillThereN", { n })}
                      onChange={(e) => set(i, e.target.checked ? { current: true, end: "" } : { current: false })}
                    />
                    {t("roles.stillThere")}
                  </label>
                  {endError && (
                    <p id={`${scope}${r.id}-end-error`} className="text-xs text-danger">
                      {endError}
                    </p>
                  )}
                </div>
                <details className="rounded-md border border-border sm:col-span-2" open={!!(r.industry || r.location || r.country) || flags.inferred.includes(at("employmentType")) || undefined}>
                  <summary className="flex min-h-10 cursor-pointer items-center px-3 text-sm font-medium">{t("roles.more", { n })}</summary>
                  <div className="grid gap-3 p-3 pt-1 sm:grid-cols-2">
                    <Field label={t("roles.industry")} uid={r.id}>
                      {(id) => <Input id={id} className="h-10" value={r.industry} maxLength={80} onChange={(e) => set(i, { industry: e.target.value })} />}
                    </Field>
                    <Field label={t("roles.location")} uid={r.id}>
                      {(id) => <Input id={id} className="h-10" value={r.location} maxLength={80} onChange={(e) => set(i, { location: e.target.value })} />}
                    </Field>
                    <Field label={t("roles.country")} uid={r.id}>
                      {(id) => <CountrySelect id={id} className="h-10" value={r.country || null} emptyLabel={t("notSet")} onChange={(country) => set(i, { country: country ?? "" })} />}
                    </Field>
                    <Field label={tPrefs("employmentTypes")} uid={r.id} check={flags.inferred.includes(at("employmentType"))}>
                      {(id, aria) => (
                        <Select
                          id={id}
                          className="h-10"
                          {...aria}
                          value={r.employmentType}
                          onChange={(e) =>
                            set(i, {
                              employmentType: e.target.value as RoleCard["employmentType"],
                            })
                          }
                        >
                          {EMPLOYMENT_TYPES.map((v) => (
                            <option key={v} value={v}>
                              {tPrefs(`employmentType.${v}`)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={t("roles.depth")} uid={r.id}>
                      {(id) => (
                        <Select
                          id={id}
                          className="h-10"
                          value={r.depth}
                          onChange={(e) =>
                            set(i, {
                              depth: e.target.value as RoleCard["depth"],
                            })
                          }
                        >
                          {ROLE_DEPTHS.map((v) => (
                            <option key={v} value={v}>
                              {t(`roleDepth.${v}`)}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                  </div>
                </details>
                <div className="flex items-end">
                  <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => onChange(roles.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3.5" aria-hidden />
                    {t("roles.remove", { n })}
                  </Button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div>
        <Button type="button" size="sm" variant="secondary" className="h-10" onClick={add}>
          <Plus className="size-3.5" aria-hidden />
          {t("roles.add")}
        </Button>
      </div>
    </div>
  );
}

type Education = FormCardValue<"education">;

/** Education and certifications, as facts. */
export function EducationRows({ value, onChange }: { value: Education; onChange: (next: Education) => void }) {
  const t = useTranslations("cvBuilder");
  const { education, certifications } = value;
  const setEducation = (next: Education["education"]) => onChange({ ...value, education: next });
  const setCertifications = (next: Education["certifications"]) => onChange({ ...value, certifications: next });
  const nullable = (v: string) => (v.trim() ? v : null);
  const year = (v: string) => nullable(v.replace(/[^\d-]/g, "").slice(0, 7));
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3">
        {education.map((e, i) => {
          const n = i + 1;
          const set = (patch: Partial<Education["education"][number]>) => setEducation(education.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <li key={e.id}>
              <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm font-medium">{t("education.rowLegend", { n })}</legend>
                <Field label={t("education.institution", { n })}>
                  {(id) => <Input id={id} className="h-10" aria-required value={e.institution} onChange={(ev) => set({ institution: ev.target.value })} />}
                </Field>
                <Field label={t("education.degree", { n })}>{(id) => <Input id={id} className="h-10" value={e.degree ?? ""} onChange={(ev) => set({ degree: nullable(ev.target.value) })} />}</Field>
                <Field label={t("education.field", { n })}>{(id) => <Input id={id} className="h-10" value={e.field ?? ""} onChange={(ev) => set({ field: nullable(ev.target.value) })} />}</Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("education.start", { n })}>
                    {(id) => <Input id={id} className="h-10" inputMode="numeric" value={e.start ?? ""} placeholder="2012" onChange={(ev) => set({ start: year(ev.target.value) })} />}
                  </Field>
                  <Field label={t("education.end", { n })}>
                    {(id) => <Input id={id} className="h-10" inputMode="numeric" value={e.end ?? ""} placeholder="2015" onChange={(ev) => set({ end: year(ev.target.value) })} />}
                  </Field>
                </div>
                <div className="flex items-end">
                  <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => setEducation(education.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3.5" aria-hidden />
                    {t("education.remove", { n })}
                  </Button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-10"
          onClick={() =>
            setEducation([
              ...education,
              {
                id: `edu-${Date.now().toString(36)}`,
                institution: "",
                degree: null,
                field: null,
                country: null,
                start: null,
                end: null,
              },
            ])
          }
        >
          <Plus className="size-3.5" aria-hidden />
          {t("education.add")}
        </Button>
      </div>
      <ol className="flex flex-col gap-3">
        {certifications.map((c, i) => {
          const n = i + 1;
          const set = (patch: Partial<Education["certifications"][number]>) => setCertifications(certifications.map((x, j) => (j === i ? { ...x, ...patch } : x)));
          return (
            <li key={i}>
              <fieldset className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
                <legend className="px-1 text-sm font-medium">{t("education.certLegend", { n })}</legend>
                <Field label={t("education.certName", { n })}>{(id) => <Input id={id} className="h-10" aria-required value={c.name} onChange={(ev) => set({ name: ev.target.value })} />}</Field>
                <Field label={t("education.issuer", { n })}>{(id) => <Input id={id} className="h-10" value={c.issuer ?? ""} onChange={(ev) => set({ issuer: nullable(ev.target.value) })} />}</Field>
                <Field label={t("education.year", { n })}>
                  {(id) => <Input id={id} className="h-10" inputMode="numeric" value={c.year ?? ""} onChange={(ev) => set({ year: year(ev.target.value) })} />}
                </Field>
                <div className="flex items-end">
                  <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => setCertifications(certifications.filter((_, j) => j !== i))}>
                    <Trash2 className="size-3.5" aria-hidden />
                    {t("education.removeCert", { n })}
                  </Button>
                </div>
              </fieldset>
            </li>
          );
        })}
      </ol>
      <div>
        <Button type="button" size="sm" variant="secondary" className="h-10" onClick={() => setCertifications([...certifications, { name: "", issuer: null, year: null }])}>
          <Plus className="size-3.5" aria-hidden />
          {t("education.addCert")}
        </Button>
      </div>
    </div>
  );
}

type Languages = FormCardValue<"languages">["languages"];

/** Languages and levels. A level nobody typed starts empty and has to be picked. */
export function LanguageRows({
  value: languages,
  onChange,
  cvLanguage,
  flags = NO_FLAGS,
}: {
  value: Languages;
  onChange: (next: Languages) => void;
  /** Language names are written in the CV's language. */
  cvLanguage: string;
  flags?: FieldFlags;
}) {
  const t = useTranslations("cvBuilder");
  const tProfile = useTranslations("profile");
  const error = useFieldError(flags);
  const set = (i: number, patch: Partial<Languages[number]>) => onChange(languages.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3">
        {languages.map((l, i) => {
          const n = i + 1;
          return (
            <li key={i} className="grid gap-3 sm:grid-cols-3">
              <Field label={t("languages.language", { n })}>
                {(id) => <LanguageCombobox id={id} labelId={`${id}-label`} value={l.language} listLocale={cvLanguage} onChange={(language) => set(i, { language })} />}
              </Field>
              <Field label={t("languages.level", { n })} check={flags.inferred.includes(`languages.${i}.level`)} error={error(`languages.${i}.level`, "level")}>
                {(id, aria) => (
                  <Select
                    id={id}
                    className="h-10"
                    {...aria}
                    aria-required
                    value={l.level}
                    onChange={(e) =>
                      set(i, {
                        level: e.target.value as Languages[number]["level"],
                      })
                    }
                  >
                    {!l.level && <option value="">{t("languages.pickLevel")}</option>}
                    {LANGUAGE_LEVELS.map((v) => (
                      <option key={v} value={v}>
                        {tProfile(`languageLevel.${v}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="flex items-end">
                <Button type="button" size="sm" variant="ghost" className="h-10" onClick={() => onChange(languages.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" aria-hidden />
                  {t("languages.remove", { n })}
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <div>
        <Button type="button" size="sm" variant="secondary" className="h-10" onClick={() => onChange([...languages, { language: "", level: "" }])}>
          <Plus className="size-3.5" aria-hidden />
          {t("languages.add")}
        </Button>
      </div>
    </div>
  );
}
