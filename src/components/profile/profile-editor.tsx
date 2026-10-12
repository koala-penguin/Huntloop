"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  CLEARANCE_STATUSES,
  LANGUAGE_LEVELS,
  type ProfileData,
  type WorkRight,
} from "@/shared/schemas/profile";
import { marketPack } from "@/shared/markets";
import { useCountryNames } from "@/components/i18n/country-names";
import { experienceYears } from "@/shared/experience";
import { stableStringify } from "@/shared/stable-json";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Select, Textarea } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { TagInput } from "@/components/ui/tag-input";
import { CountrySelect } from "@/components/ui/country-select";
import { saveProfileAction } from "@/app/profile/actions";

interface Props {
  version: number;
  cvText: string;
  data: ProfileData;
  /** Countries from job preferences: always shown in the work-rights section. */
  preferenceCountries: string[];
}

const blank = (v: string) => (v.trim() === "" ? null : v);
const DATE = /^\d{4}(-\d{2})?$/;

/** Drops empty rows and blank lines the editor creates while typing. */
function cleanProfile(d: ProfileData): ProfileData {
  return {
    ...d,
    experience: d.experience
      .filter((r) => r.title.trim() || r.company.trim())
      .map((r) => ({ ...r, start: r.start?.trim() || null, highlights: r.highlights.map((h) => h.trim()).filter(Boolean) })),
    education: d.education.filter((e) => e.institution.trim()),
    certifications: d.certifications.filter((c) => c.name.trim()),
    languages: d.languages.filter((l) => l.language.trim()),
    clearances: d.clearances.filter((c) => c.level.trim()),
  };
}
let idCounter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(idCounter++).toString(36)}`;

function Section({ title, description, children, action }: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
        {action}
      </CardHeader>
      {children}
    </Card>
  );
}

function Field({ label, children, hint, className }: { label: string; children: ReactNode; hint?: string; className?: string }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <FieldHint>{hint}</FieldHint>}
    </label>
  );
}

export function ProfileEditor({ version, cvText: initialCvText, data: initialData, preferenceCountries }: Props) {
  const t = useTranslations("profile");
  const tMarkets = useTranslations("markets");
  const tCommon = useTranslations("common");
  const { name: countryNameOf } = useCountryNames();
  const router = useRouter();
  const [data, setData] = useState<ProfileData>(initialData);
  const [cvText, setCvText] = useState(initialCvText);
  const [newFact, setNewFact] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" } | { kind: "saved"; version: number } | { kind: "error"; message: string }>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  // A new version from outside (e.g. a freshly read CV) replaces the form. When the new version is
  // just what we saved, keep the form (and the "saved" message) as it is.
  const [syncedVersion, setSyncedVersion] = useState(version);
  if (version !== syncedVersion) {
    setSyncedVersion(version);
    const unchanged =
      initialCvText === cvText && stableStringify(initialData) === stableStringify(cleanProfile(data));
    if (!unchanged) {
      setData(initialData);
      setCvText(initialCvText);
      setStatus({ kind: "idle" });
    }
  }

  const update = (fn: (d: ProfileData) => ProfileData) => {
    setData(fn);
    setStatus({ kind: "idle" });
  };
  const removeLabel = (tag: string) => t("removeItem", { item: tag });
  const years = experienceYears(data.experience);

  const workRightCountries = useMemo(() => {
    const set = new Set<string>(preferenceCountries);
    for (const w of data.workRights) set.add(w.country);
    return [...set];
  }, [preferenceCountries, data.workRights]);

  const setWorkRight = (country: string, optionId: string, extra?: Partial<WorkRight>) =>
    update((d) => {
      const rest = d.workRights.filter((w) => w.country !== country);
      if (!optionId) return { ...d, workRights: rest };
      const option = marketPack(country).workRightOptions.find((o) => o.id === optionId);
      const current = d.workRights.find((w) => w.country === country);
      const next: WorkRight = {
        country,
        status: optionId === "unknown" ? "unknown" : (option?.status ?? "unknown"),
        option: optionId === "unknown" ? null : optionId,
        expires: current?.expires ?? null,
        note: current?.note ?? null,
        ...extra,
      };
      return { ...d, workRights: [...rest, next] };
    });

  const save = () =>
    startTransition(async () => {
      const cleaned = cleanProfile(data);
      if (cleaned.experience.some((r) => (r.start !== null && !DATE.test(r.start)) || (r.end !== null && !DATE.test(r.end)))) {
        setStatus({ kind: "error", message: t("dateError") });
        return;
      }
      const result = await saveProfileAction({ cvText, data: cleaned });
      if (result.ok) {
        setStatus({ kind: "saved", version: result.value.version });
        router.refresh();
      } else setStatus({ kind: "error", message: tCommon("saveFailed", { message: result.error }) });
    });

  return (
    <div className="flex flex-col gap-4">
      <Section title={t("aboutTitle")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("name")}>
            <Input value={data.basics.name ?? ""} onChange={(e) => update((d) => ({ ...d, basics: { ...d.basics, name: blank(e.target.value) } }))} />
          </Field>
          <Field label={t("headline")}>
            <Input value={data.basics.headline ?? ""} onChange={(e) => update((d) => ({ ...d, basics: { ...d.basics, headline: blank(e.target.value) } }))} />
          </Field>
          <Field label={t("city")}>
            <Input value={data.basics.city ?? ""} onChange={(e) => update((d) => ({ ...d, basics: { ...d.basics, city: blank(e.target.value) } }))} />
          </Field>
          <Field label={t("country")}>
            <CountrySelect value={data.basics.country} emptyLabel={t("notSet")} onChange={(c) => update((d) => ({ ...d, basics: { ...d.basics, country: c } }))} />
          </Field>
          <Field label={t("email")}>
            <Input type="email" value={data.basics.email ?? ""} onChange={(e) => update((d) => ({ ...d, basics: { ...d.basics, email: blank(e.target.value) } }))} />
          </Field>
          <Field label={t("phone")}>
            <Input value={data.basics.phone ?? ""} onChange={(e) => update((d) => ({ ...d, basics: { ...d.basics, phone: blank(e.target.value) } }))} />
          </Field>
          <Field label={t("summary")} className="sm:col-span-2">
            <Textarea rows={3} value={data.basics.summary ?? ""} onChange={(e) => update((d) => ({ ...d, basics: { ...d.basics, summary: blank(e.target.value) } }))} />
          </Field>
          <Field label={t("links")} className="sm:col-span-2">
            <TagInput value={data.basics.links} removeLabel={removeLabel} onChange={(links) => update((d) => ({ ...d, basics: { ...d.basics, links } }))} aria-label={t("links")} />
          </Field>
        </div>
      </Section>

      <Section title={t("workRightsTitle")} description={t("workRightsDescription")}>
        <ul className="flex flex-col gap-4">
          {workRightCountries.map((country) => {
            const entry = data.workRights.find((w) => w.country === country);
            const pack = marketPack(country);
            const selected = entry ? (entry.status === "unknown" ? "unknown" : (entry.option ?? "")) : "";
            return (
              <li key={country} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[1fr_2fr_1fr] sm:items-end">
                <p className="text-sm font-medium">{countryNameOf(country)}</p>
                <Field label={t("workRightLabel")}>
                  <Select value={selected} onChange={(e) => setWorkRight(country, e.target.value)}>
                    <option value="">{t("notSet")}</option>
                    {pack.workRightOptions.map((o) => (
                      <option key={o.id} value={o.id}>
                        {tMarkets(`workRights.${o.id}`)}
                      </option>
                    ))}
                    <option value="unknown">{tMarkets("workRights.unknown")}</option>
                  </Select>
                </Field>
                <Field label={t("visaExpires")}>
                  <Input
                    type="date"
                    value={entry?.expires ?? ""}
                    disabled={!entry || entry.status === "citizen"}
                    onChange={(e) => entry && setWorkRight(country, selected, { expires: blank(e.target.value) })}
                  />
                </Field>
                {entry?.note && <FieldHint className="sm:col-span-3">{t("fromCv", { text: entry.note })}</FieldHint>}
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex max-w-sm items-end gap-2">
          <Field label={t("addCountry")} className="flex-1">
            <CountrySelect
              value={null}
              emptyLabel={t("chooseCountry")}
              exclude={workRightCountries}
              onChange={(c) => c && setWorkRight(c, "unknown")}
            />
          </Field>
        </div>
      </Section>

      <Section
        title={t("experienceTitle")}
        description={t("experienceYears", { years })}
        action={
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() =>
              update((d) => ({
                ...d,
                experience: [
                  { id: newId("exp"), title: "", company: "", industry: null, location: null, country: null, start: null, end: null, seniority: null, skills: [], highlights: [] },
                  ...d.experience,
                ],
              }))
            }
          >
            <Plus className="size-4" aria-hidden />
            {t("addRole")}
          </Button>
        }
      >
        <ul className="flex flex-col gap-4">
          {data.experience.map((role, index) => {
            const setRole = (patch: Partial<typeof role>) =>
              update((d) => ({ ...d, experience: d.experience.map((r, i) => (i === index ? { ...r, ...patch } : r)) }));
            return (
              <li key={role.id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
                <Field label={t("roleTitle")}>
                  <Input value={role.title} onChange={(e) => setRole({ title: e.target.value })} />
                </Field>
                <Field label={t("company")}>
                  <Input value={role.company} onChange={(e) => setRole({ company: e.target.value })} />
                </Field>
                <Field label={t("start")} hint={t("dateHint")}>
                  <Input value={role.start ?? ""} placeholder="2021-03" onChange={(e) => setRole({ start: blank(e.target.value) })} />
                </Field>
                <Field label={t("end")} hint={t("dateHint")}>
                  <div className="flex items-center gap-3">
                    <Input value={role.end ?? ""} placeholder="2024-06" disabled={role.end === null} onChange={(e) => setRole({ end: e.target.value })} />
                    <label className="flex shrink-0 items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={role.end === null} onChange={(e) => setRole({ end: e.target.checked ? null : "" })} />
                      {t("current")}
                    </label>
                  </div>
                </Field>
                <Field label={t("location")}>
                  <Input value={role.location ?? ""} onChange={(e) => setRole({ location: blank(e.target.value) })} />
                </Field>
                <Field label={t("roleSkills")}>
                  <TagInput value={role.skills} removeLabel={removeLabel} onChange={(skills) => setRole({ skills })} aria-label={t("roleSkills")} />
                </Field>
                <Field label={t("highlights")} hint={t("highlightsHint")} className="sm:col-span-2">
                  <Textarea rows={4} value={role.highlights.join("\n")} onChange={(e) => setRole({ highlights: e.target.value.split("\n") })} />
                </Field>
                <div className="sm:col-span-2">
                  <Button type="button" variant="ghost" size="sm" onClick={() => update((d) => ({ ...d, experience: d.experience.filter((_, i) => i !== index) }))}>
                    <Trash2 className="size-4" aria-hidden />
                    {t("remove")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={t("skillsTitle")} description={t("skillsDescription")}>
        <TagInput
          value={data.skills.map((s) => s.name)}
          removeLabel={removeLabel}
          aria-label={t("skillsTitle")}
          onChange={(names) =>
            update((d) => ({
              ...d,
              skills: names.map((name) => d.skills.find((s) => s.name === name) ?? { name, category: "other" as const }),
            }))
          }
        />
      </Section>

      <Section
        title={t("educationTitle")}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={() => update((d) => ({ ...d, education: [...d.education, { id: newId("edu"), institution: "", degree: null, field: null, country: null, start: null, end: null }] }))}>
            <Plus className="size-4" aria-hidden />
            {t("add")}
          </Button>
        }
      >
        <ul className="flex flex-col gap-3">
          {data.education.map((edu, index) => {
            const setEdu = (patch: Partial<typeof edu>) => update((d) => ({ ...d, education: d.education.map((e, i) => (i === index ? { ...e, ...patch } : e)) }));
            return (
              <li key={edu.id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:items-end">
                <Field label={t("institution")}>
                  <Input value={edu.institution} onChange={(e) => setEdu({ institution: e.target.value })} />
                </Field>
                <Field label={t("degree")}>
                  <Input value={edu.degree ?? ""} onChange={(e) => setEdu({ degree: blank(e.target.value) })} />
                </Field>
                <Field label={t("field")}>
                  <Input value={edu.field ?? ""} onChange={(e) => setEdu({ field: blank(e.target.value) })} />
                </Field>
                <Field label={t("endYear")}>
                  <Input value={edu.end ?? ""} onChange={(e) => setEdu({ end: blank(e.target.value) })} />
                </Field>
                <Button type="button" variant="ghost" size="sm" aria-label={t("remove")} onClick={() => update((d) => ({ ...d, education: d.education.filter((_, i) => i !== index) }))}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section
        title={t("certificationsTitle")}
        action={
          <Button type="button" variant="secondary" size="sm" onClick={() => update((d) => ({ ...d, certifications: [...d.certifications, { name: "", issuer: null, year: null }] }))}>
            <Plus className="size-4" aria-hidden />
            {t("add")}
          </Button>
        }
      >
        <ul className="flex flex-col gap-3">
          {data.certifications.map((cert, index) => {
            const setCert = (patch: Partial<typeof cert>) =>
              update((d) => ({ ...d, certifications: d.certifications.map((c, i) => (i === index ? { ...c, ...patch } : c)) }));
            return (
              <li key={index} className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
                <Field label={t("certName")}>
                  <Input value={cert.name} onChange={(e) => setCert({ name: e.target.value })} />
                </Field>
                <Field label={t("issuer")}>
                  <Input value={cert.issuer ?? ""} onChange={(e) => setCert({ issuer: blank(e.target.value) })} />
                </Field>
                <Field label={t("year")}>
                  <Input value={cert.year ?? ""} onChange={(e) => setCert({ year: blank(e.target.value) })} />
                </Field>
                <Button type="button" variant="ghost" size="sm" aria-label={t("remove")} onClick={() => update((d) => ({ ...d, certifications: d.certifications.filter((_, i) => i !== index) }))}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            );
          })}
        </ul>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          title={t("languagesTitle")}
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => update((d) => ({ ...d, languages: [...d.languages, { language: "", level: "professional" }] }))}>
              <Plus className="size-4" aria-hidden />
              {t("add")}
            </Button>
          }
        >
          <ul className="flex flex-col gap-3">
            {data.languages.map((lang, index) => (
              <li key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                <Field label={t("language")}>
                  <Input value={lang.language} onChange={(e) => update((d) => ({ ...d, languages: d.languages.map((l, i) => (i === index ? { ...l, language: e.target.value } : l)) }))} />
                </Field>
                <Field label={t("level")}>
                  <Select value={lang.level} onChange={(e) => update((d) => ({ ...d, languages: d.languages.map((l, i) => (i === index ? { ...l, level: e.target.value as typeof l.level } : l)) }))}>
                    {LANGUAGE_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {t(`languageLevel.${level}`)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Button type="button" variant="ghost" size="sm" aria-label={t("remove")} onClick={() => update((d) => ({ ...d, languages: d.languages.filter((_, i) => i !== index) }))}>
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title={t("clearancesTitle")}
          description={t("clearancesDescription")}
          action={
            <Button type="button" variant="secondary" size="sm" onClick={() => update((d) => ({ ...d, clearances: [...d.clearances, { country: preferenceCountries[0] ?? "AU", level: "", status: "active" }] }))}>
              <Plus className="size-4" aria-hidden />
              {t("add")}
            </Button>
          }
        >
          <ul className="flex flex-col gap-3">
            {data.clearances.map((c, index) => {
              const setClearance = (patch: Partial<typeof c>) => update((d) => ({ ...d, clearances: d.clearances.map((x, i) => (i === index ? { ...x, ...patch } : x)) }));
              const levels = marketPack(c.country).clearanceLevels;
              return (
                <li key={index} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                  <Field label={t("country")}>
                    <CountrySelect value={c.country} onChange={(code) => code && setClearance({ country: code })} />
                  </Field>
                  <Field label={t("level")}>
                    {levels.length ? (
                      <Select value={c.level} onChange={(e) => setClearance({ level: e.target.value })}>
                        <option value="">{t("notSet")}</option>
                        {levels.map((l) => (
                          <option key={l} value={l}>
                            {l}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input value={c.level} onChange={(e) => setClearance({ level: e.target.value })} />
                    )}
                  </Field>
                  <Field label={t("clearanceStatus")}>
                    <Select value={c.status} onChange={(e) => setClearance({ status: e.target.value as typeof c.status })}>
                      {CLEARANCE_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {t(`clearanceStatusValue.${s}`)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button type="button" variant="ghost" size="sm" aria-label={t("remove")} onClick={() => update((d) => ({ ...d, clearances: d.clearances.filter((_, i) => i !== index) }))}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        </Section>
      </div>

      <Section title={t("factsTitle")} description={t("factsDescription")}>
        <ul className="flex flex-col gap-2">
          {data.facts.map((fact) => (
            <li key={fact.id} className="flex items-start justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
              <span>{fact.text}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Badge tone="outline">{t(`factSource.${fact.source}`)}</Badge>
                <button type="button" className="text-muted hover:text-danger" aria-label={t("remove")} onClick={() => update((d) => ({ ...d, facts: d.facts.filter((f) => f.id !== fact.id) }))}>
                  <Trash2 className="size-4" aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label={t("newFact")} className="flex-1">
            <Input value={newFact} placeholder={t("newFactPlaceholder")} onChange={(e) => setNewFact(e.target.value)} />
          </Field>
          <Button
            type="button"
            variant="secondary"
            disabled={!newFact.trim()}
            onClick={() => {
              update((d) => ({ ...d, facts: [...d.facts, { id: newId("fact"), text: newFact.trim(), source: "user" }] }));
              setNewFact("");
            }}
          >
            <Plus className="size-4" aria-hidden />
            {t("addFact")}
          </Button>
        </div>
      </Section>

      <Section title={t("cvTextTitle")} description={t("cvTextDescription")}>
        <details>
          <summary className="cursor-pointer text-sm text-accent">{t("showCvText")}</summary>
          <Textarea className="mt-3 font-mono text-xs" rows={18} value={cvText} onChange={(e) => { setCvText(e.target.value); setStatus({ kind: "idle" }); }} aria-label={t("cvTextTitle")} />
        </details>
      </Section>

      <div className="sticky bottom-0 -mx-4 flex items-center gap-3 border-t border-border bg-background/95 px-4 py-3 backdrop-blur md:mx-0 md:rounded-lg md:border">
        <Button type="button" onClick={save} disabled={pending}>
          {pending ? tCommon("saving") : t("saveProfile")}
        </Button>
        <span className="text-sm text-muted">{t("versionInfo", { version })}</span>
        {status.kind === "saved" && <span className="text-sm text-accent">{t("savedVersion", { version: status.version })}</span>}
        {status.kind === "error" && <span className="text-sm text-danger">{status.message}</span>}
      </div>
    </div>
  );
}
