"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { ArrowRight, Plus, SkipForward, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label, Select } from "@/components/ui/form";
import { TagInput } from "@/components/ui/tag-input";
import { CountrySelect } from "@/components/ui/country-select";
import { marketPack } from "@/shared/markets";
import { EMPLOYMENT_TYPES, WORKPLACE_TYPES } from "@/shared/schemas/preferences";
import { LANGUAGE_LEVELS, SENIORITY_LEVELS, type WorkRight } from "@/shared/schemas/profile";
import { CV_LANGUAGES } from "@/shared/schemas/cv";
import { CURRENT_STATUSES, INTERVIEW_DEPTHS, INTERVIEW_PERSONAS, ROLE_DEPTHS, type InterviewForm, type RoleForm } from "@/shared/schemas/interview";
import { saveStageFormAction, skipStageAction, startInterviewAction } from "@/app/profile/interview/actions";

/** The CV builder's form stages. Each saves through one server action; "Save and continue" also moves on. */

function Field({ label, hint, children, className, uid }: { label: string; hint?: string; children: (id: string) => ReactNode; className?: string; uid?: string }) {
  const id = `f-${label.replace(/\W+/g, "-").toLowerCase()}${uid ? `-${uid}` : ""}`;
  return (
    <div className={`flex flex-col gap-1.5 ${className ?? ""}`}>
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <FieldHint>{hint}</FieldHint>}
    </div>
  );
}

function Checks<T extends string>({ legend, values, selected, label, onChange }: { legend: string; values: readonly T[]; selected: T[]; label: (v: T) => string; onChange: (next: T[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {values.map((v) => (
          <label key={v} className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={selected.includes(v)} onChange={(e) => onChange(e.target.checked ? [...selected, v] : selected.filter((s) => s !== v))} />
            {label(v)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function useStageSave(interviewId: number) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const result = await fn();
      if (!result.ok) setError(result.error ?? "invalid");
      else router.refresh();
    });
  return {
    pending,
    error,
    save: (stage: string, value: unknown, advance: boolean) => run(() => saveStageFormAction(interviewId, stage, value, advance)),
    skip: (key: string) => run(() => skipStageAction(interviewId, key)),
  };
}

function StageCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <div className="flex flex-col gap-5">{children}</div>
    </Card>
  );
}

function Actions({ pending, error, onSave, onContinue, onSkip }: { pending: boolean; error: string | null; onSave?: () => void; onContinue: () => void; onSkip?: () => void }) {
  const t = useTranslations("interview");
  const tErrors = useTranslations("errors");
  return (
    <div className="flex flex-col gap-2">
      {error && <Alert tone="danger">{error === "invalid" ? t("invalidForm") : tErrors("generic", { message: error })}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={onContinue}>
          <ArrowRight className="size-3.5" aria-hidden />
          {t("saveContinue")}
        </Button>
        {onSave && (
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={onSave}>
            {t("save")}
          </Button>
        )}
        {onSkip && (
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onSkip}>
            <SkipForward className="size-3.5" aria-hidden />
            {t("skip")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Stage 0: language, market, who the user is and how deep to go. Starts the interview (or edits it). */
export function SetupForm({ interviewId, initial }: { interviewId: number | null; initial: InterviewForm["setup"] }) {
  const t = useTranslations("interview");
  const router = useRouter();
  const [setup, setSetup] = useState(initial);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const saver = useStageSave(interviewId ?? 0);
  const begin = () =>
    start(async () => {
      const result = await startInterviewAction(setup);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  return (
    <StageCard title={t("setup.title")} description={t("setup.description")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("setup.language")}>
          {(id) => (
            <Select id={id} value={setup.language} onChange={(e) => setSetup({ ...setup, language: e.target.value as typeof setup.language })}>
              {CV_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t(`languageName.${l}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("setup.country")} hint={t("setup.countryHint")}>
          {(id) => <CountrySelect id={id} value={setup.country} onChange={(country) => country && setSetup({ ...setup, country })} />}
        </Field>
      </div>
      <Checks legend={t("setup.personas")} values={INTERVIEW_PERSONAS} selected={setup.personas} label={(v) => t(`persona.${v}`)} onChange={(personas) => setSetup({ ...setup, personas })} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("setup.depth")}</legend>
        {INTERVIEW_DEPTHS.map((d) => (
          <label key={d} className="flex items-start gap-2 text-sm">
            <input type="radio" name="depth" className="mt-1" checked={setup.depth === d} onChange={() => setSetup({ ...setup, depth: d })} />
            <span>
              <span className="font-medium">{t(`depth.${d}`)}</span> <span className="text-muted">{t(`depthHint.${d}`)}</span>
            </span>
          </label>
        ))}
        <FieldHint>{t("setup.costHint")}</FieldHint>
      </fieldset>
      {interviewId === null ? (
        <div className="flex flex-col gap-2">
          {error && <Alert tone="danger">{t("invalidForm")}</Alert>}
          <div>
            <Button type="button" disabled={pending} onClick={begin}>
              <ArrowRight className="size-4" aria-hidden />
              {t("setup.start")}
            </Button>
          </div>
        </div>
      ) : (
        <Actions pending={saver.pending} error={saver.error} onContinue={() => saver.save("setup", setup, true)} />
      )}
    </StageCard>
  );
}

function WorkRightSelect({ country, value, onChange }: { country: string; value: WorkRight[]; onChange: (next: WorkRight[]) => void }) {
  const t = useTranslations("interview");
  const tMarkets = useTranslations("markets");
  const pack = marketPack(country);
  const entry = value.find((w) => w.country === country);
  const selected = entry ? (entry.status === "unknown" ? "unknown" : (entry.option ?? "")) : "";
  const set = (optionId: string) => {
    const rest = value.filter((w) => w.country !== country);
    if (!optionId) return onChange(rest);
    const option = pack.workRightOptions.find((o) => o.id === optionId);
    onChange([...rest, { country, status: optionId === "unknown" ? "unknown" : (option?.status ?? "unknown"), option: optionId === "unknown" ? null : optionId, expires: null, note: null }]);
  };
  return (
    <Field label={t("target.workRights")}>
      {(id) => (
        <Select id={id} value={selected} onChange={(e) => set(e.target.value)}>
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

/** Stage 1: the job they're after, in the target market. */
export function TargetForm({ interviewId, initial, country }: { interviewId: number; initial: InterviewForm["target"]; country: string }) {
  const t = useTranslations("interview");
  const tPrefs = useTranslations("preferences");
  const tProfile = useTranslations("profile");
  const [target, setTarget] = useState(initial);
  const { pending, error, save } = useStageSave(interviewId);
  const removeLabel = (tag: string) => tProfile("removeItem", { item: tag });
  const levels = marketPack(country).clearanceLevels;
  const clearance = target.clearances.find((c) => c.country === country)?.level ?? "";
  return (
    <StageCard title={t("target.title")} description={t("target.description")}>
      <Field label={tPrefs("targetTitles")} hint={tPrefs("targetTitlesHint")}>
        {(id) => <TagInput id={id} value={target.titles} removeLabel={removeLabel} placeholder={tPrefs("targetTitlesPlaceholder")} onChange={(titles) => setTarget({ ...target, titles })} />}
      </Field>
      <Checks legend={tPrefs("seniority")} values={SENIORITY_LEVELS} selected={target.seniority} label={(v) => tPrefs(`seniorityValue.${v}`)} onChange={(seniority) => setTarget({ ...target, seniority })} />
      <Field label={t("target.industries")}>{(id) => <TagInput id={id} value={target.industries} removeLabel={removeLabel} onChange={(industries) => setTarget({ ...target, industries })} />}</Field>
      <Field label={tPrefs("cities")} hint={tPrefs("citiesHint")}>
        {(id) => <TagInput id={id} value={target.cities} removeLabel={removeLabel} suggestions={marketPack(country).suggestedCities} onChange={(cities) => setTarget({ ...target, cities })} />}
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={target.remoteOk} onChange={(e) => setTarget({ ...target, remoteOk: e.target.checked })} />
        {tPrefs("remoteOk")}
      </label>
      <Checks legend={tPrefs("workplace")} values={WORKPLACE_TYPES} selected={target.workplace} label={(v) => tPrefs(`workplaceType.${v}`)} onChange={(workplace) => setTarget({ ...target, workplace })} />
      <Checks legend={tPrefs("employmentTypes")} values={EMPLOYMENT_TYPES} selected={target.employmentTypes} label={(v) => tPrefs(`employmentType.${v}`)} onChange={(employmentTypes) => setTarget({ ...target, employmentTypes })} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={target.willingToRelocate} onChange={(e) => setTarget({ ...target, willingToRelocate: e.target.checked })} />
        {tPrefs("willingToRelocate")}
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <WorkRightSelect country={country} value={target.workRights} onChange={(workRights) => setTarget({ ...target, workRights })} />
        {levels.length > 0 && (
          <Field label={t("target.clearance")}>
            {(id) => (
              <Select
                id={id}
                value={clearance}
                onChange={(e) =>
                  setTarget({ ...target, clearances: [...target.clearances.filter((c) => c.country !== country), ...(e.target.value ? [{ country, level: e.target.value, status: "active" as const }] : [])] })
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
        <Field label={t("target.availability")} hint={t("target.availabilityHint")}>
          {(id) => <Input id={id} value={target.availability} maxLength={200} onChange={(e) => setTarget({ ...target, availability: e.target.value })} />}
        </Field>
      </div>
      <Actions pending={pending} error={error} onContinue={() => save("target", target, true)} />
    </StageCard>
  );
}

/** Stage 2 (form part): where they are now. The chat about it follows on the same page. */
export function CurrentForm({ interviewId, initial }: { interviewId: number; initial: InterviewForm["current"] }) {
  const t = useTranslations("interview");
  const [current, setCurrent] = useState(initial);
  const { pending, error, save } = useStageSave(interviewId);
  const working = current.status === "employed" || current.status === "self_employed";
  return (
    <StageCard title={t("current.title")} description={t("current.description")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t("current.status")}>
          {(id) => (
            <Select id={id} value={current.status} onChange={(e) => setCurrent({ ...current, status: e.target.value as typeof current.status })}>
              {CURRENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`currentStatus.${s}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={working ? t("current.titleNow") : t("current.titleLast")}>{(id) => <Input id={id} value={current.title} maxLength={120} onChange={(e) => setCurrent({ ...current, title: e.target.value })} />}</Field>
        <Field label={t("roles.company")}>{(id) => <Input id={id} value={current.company} maxLength={120} onChange={(e) => setCurrent({ ...current, company: e.target.value })} />}</Field>
        <Field label={t("roles.start")} hint={t("dateHint")}>{(id) => <Input id={id} value={current.start} placeholder="2021-03" onChange={(e) => setCurrent({ ...current, start: e.target.value.trim() })} />}</Field>
        <Field label={t("roles.country")}>{(id) => <CountrySelect id={id} value={current.country || null} emptyLabel={t("notSet")} onChange={(country) => setCurrent({ ...current, country: country ?? "" })} />}</Field>
      </div>
      <div className="flex flex-col gap-2">
        {error && <Alert tone="danger">{t("invalidForm")}</Alert>}
        <div>
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => save("current", current, false)}>
            {t("save")}
          </Button>
        </div>
      </div>
    </StageCard>
  );
}

const nextRoleId = (roles: RoleForm[]) => `exp-${Math.max(0, ...roles.map((r) => Number(r.id.slice(4)) || 0)) + 1}`;

/** Stage 3: every role, as a table. Ids stay fixed so answers stay with their role. */
export function RolesForm({ interviewId, initial, quick }: { interviewId: number; initial: RoleForm[]; quick: boolean }) {
  const t = useTranslations("interview");
  const tPrefs = useTranslations("preferences");
  const [roles, setRoles] = useState<RoleForm[]>(initial);
  const { pending, error, save } = useStageSave(interviewId);
  const set = (i: number, patch: Partial<RoleForm>) => setRoles(roles.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const add = () =>
    setRoles([
      ...roles,
      { id: nextRoleId(roles), title: "", company: "", industry: "", location: "", country: "", start: "", end: "", employmentType: "full_time", seniority: null, depth: quick && roles.length ? "brief" : "deep" },
    ]);
  return (
    <StageCard title={t("roles.title")} description={t("roles.description")}>
      <ol className="flex flex-col gap-4">
        {roles.map((r, i) => (
          <li key={r.id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3" data-role-row={r.id}>
            <Field label={t("roles.roleTitle", { n: i + 1 })}>{(id) => <Input id={id} value={r.title} maxLength={120} onChange={(e) => set(i, { title: e.target.value })} />}</Field>
            <Field label={t("roles.companyN", { n: i + 1 })}>{(id) => <Input id={id} value={r.company} maxLength={120} onChange={(e) => set(i, { company: e.target.value })} />}</Field>
            <Field label={t("roles.industry")} uid={r.id}>{(id) => <Input id={id} value={r.industry} maxLength={80} onChange={(e) => set(i, { industry: e.target.value })} />}</Field>
            <Field label={t("roles.location")} uid={r.id}>{(id) => <Input id={id} value={r.location} maxLength={80} onChange={(e) => set(i, { location: e.target.value })} />}</Field>
            <Field label={t("roles.startN", { n: i + 1 })} hint={t("dateHint")}>{(id) => <Input id={id} value={r.start} placeholder="2021-03" onChange={(e) => set(i, { start: e.target.value.trim() })} />}</Field>
            <Field label={t("roles.endN", { n: i + 1 })} hint={t("endHint")}>{(id) => <Input id={id} value={r.end} placeholder="2023-06" onChange={(e) => set(i, { end: e.target.value.trim() })} />}</Field>
            <Field label={tPrefs("employmentTypes")} uid={r.id}>
              {(id) => (
                <Select id={id} value={r.employmentType} onChange={(e) => set(i, { employmentType: e.target.value as RoleForm["employmentType"] })}>
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
                <Select id={id} value={r.depth} onChange={(e) => set(i, { depth: e.target.value as RoleForm["depth"] })}>
                  {ROLE_DEPTHS.map((v) => (
                    <option key={v} value={v}>
                      {t(`roleDepth.${v}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex items-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setRoles(roles.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" aria-hidden />
                {t("roles.remove", { n: i + 1 })}
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={add}>
          <Plus className="size-3.5" aria-hidden />
          {t("roles.add")}
        </Button>
      </div>
      <FieldHint>{t("roles.hint")}</FieldHint>
      <Actions pending={pending} error={error} onContinue={() => save("roles", roles, true)} />
    </StageCard>
  );
}

/** Stage 6: education and certifications (facts only; no chat in this version). */
export function EducationForm({ interviewId, initial }: { interviewId: number; initial: Pick<InterviewForm, "education" | "certifications"> }) {
  const t = useTranslations("interview");
  const tProfile = useTranslations("profile");
  const [education, setEducation] = useState(initial.education);
  const [certifications, setCertifications] = useState(initial.certifications);
  const { pending, error, save, skip } = useStageSave(interviewId);
  const nullable = (v: string) => (v.trim() ? v : null);
  return (
    <StageCard title={t("education.title")} description={t("education.description")}>
      <ol className="flex flex-col gap-3">
        {education.map((e, i) => (
          <li key={e.id} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
            <Field label={t("education.institution", { n: i + 1 })}>{(id) => <Input id={id} value={e.institution} onChange={(ev) => setEducation(education.map((x, j) => (j === i ? { ...x, institution: ev.target.value } : x)))} />}</Field>
            <Field label={t("education.degree", { n: i + 1 })}>{(id) => <Input id={id} value={e.degree ?? ""} onChange={(ev) => setEducation(education.map((x, j) => (j === i ? { ...x, degree: nullable(ev.target.value) } : x)))} />}</Field>
            <Field label={t("education.field", { n: i + 1 })}>{(id) => <Input id={id} value={e.field ?? ""} onChange={(ev) => setEducation(education.map((x, j) => (j === i ? { ...x, field: nullable(ev.target.value) } : x)))} />}</Field>
            <Field label={t("education.start", { n: i + 1 })}>{(id) => <Input id={id} value={e.start ?? ""} placeholder="2012" onChange={(ev) => setEducation(education.map((x, j) => (j === i ? { ...x, start: nullable(ev.target.value) } : x)))} />}</Field>
            <Field label={t("education.end", { n: i + 1 })}>{(id) => <Input id={id} value={e.end ?? ""} placeholder="2015" onChange={(ev) => setEducation(education.map((x, j) => (j === i ? { ...x, end: nullable(ev.target.value) } : x)))} />}</Field>
            <div className="flex items-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setEducation(education.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" aria-hidden />
                {tProfile("remove")}
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setEducation([...education, { id: `edu-${Date.now().toString(36)}`, institution: "", degree: null, field: null, country: null, start: null, end: null }])}>
          <Plus className="size-3.5" aria-hidden />
          {t("education.add")}
        </Button>
      </div>
      <ol className="flex flex-col gap-3">
        {certifications.map((c, i) => (
          <li key={i} className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
            <Field label={t("education.certName", { n: i + 1 })}>{(id) => <Input id={id} value={c.name} onChange={(ev) => setCertifications(certifications.map((x, j) => (j === i ? { ...x, name: ev.target.value } : x)))} />}</Field>
            <Field label={t("education.issuer", { n: i + 1 })}>{(id) => <Input id={id} value={c.issuer ?? ""} onChange={(ev) => setCertifications(certifications.map((x, j) => (j === i ? { ...x, issuer: nullable(ev.target.value) } : x)))} />}</Field>
            <Field label={t("education.year", { n: i + 1 })}>{(id) => <Input id={id} value={c.year ?? ""} onChange={(ev) => setCertifications(certifications.map((x, j) => (j === i ? { ...x, year: nullable(ev.target.value) } : x)))} />}</Field>
          </li>
        ))}
      </ol>
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setCertifications([...certifications, { name: "", issuer: null, year: null }])}>
          <Plus className="size-3.5" aria-hidden />
          {t("education.addCert")}
        </Button>
      </div>
      <Actions
        pending={pending}
        error={error}
        onContinue={() => save("education", { education: education.filter((e) => e.institution.trim()), certifications: certifications.filter((c) => c.name.trim()) }, true)}
        onSkip={() => skip("education")}
      />
    </StageCard>
  );
}

/** Stage 9: languages and levels. */
export function LanguagesForm({ interviewId, initial }: { interviewId: number; initial: InterviewForm["languages"] }) {
  const t = useTranslations("interview");
  const tProfile = useTranslations("profile");
  const [languages, setLanguages] = useState(initial);
  const { pending, error, save, skip } = useStageSave(interviewId);
  return (
    <StageCard title={t("languages.title")} description={t("languages.description")}>
      <ol className="flex flex-col gap-3">
        {languages.map((l, i) => (
          <li key={i} className="grid gap-3 sm:grid-cols-3">
            <Field label={t("languages.language", { n: i + 1 })}>{(id) => <Input id={id} value={l.language} onChange={(e) => setLanguages(languages.map((x, j) => (j === i ? { ...x, language: e.target.value } : x)))} />}</Field>
            <Field label={t("languages.level", { n: i + 1 })}>
              {(id) => (
                <Select id={id} value={l.level} onChange={(e) => setLanguages(languages.map((x, j) => (j === i ? { ...x, level: e.target.value as typeof l.level } : x)))}>
                  {LANGUAGE_LEVELS.map((v) => (
                    <option key={v} value={v}>
                      {tProfile(`languageLevel.${v}`)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex items-end">
              <Button type="button" size="sm" variant="ghost" onClick={() => setLanguages(languages.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" aria-hidden />
                {tProfile("remove")}
              </Button>
            </div>
          </li>
        ))}
      </ol>
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={() => setLanguages([...languages, { language: "", level: "professional" }])}>
          <Plus className="size-3.5" aria-hidden />
          {t("languages.add")}
        </Button>
      </div>
      <Actions pending={pending} error={error} onContinue={() => save("languages", languages.filter((l) => l.language.trim()), true)} onSkip={() => skip("languages")} />
    </StageCard>
  );
}

/** Stage 12: how they appear on the CV. Contact details never enter the Career record. */
export function ContactForm({ interviewId, initial }: { interviewId: number; initial: InterviewForm["contact"] }) {
  const t = useTranslations("interview");
  const tProfile = useTranslations("profile");
  const [contact, setContact] = useState(initial);
  const { pending, error, save } = useStageSave(interviewId);
  const text = (key: keyof typeof contact, label: string, max: number) => (
    <Field label={label}>{(id) => <Input id={id} value={String(contact[key] ?? "")} maxLength={max} onChange={(e) => setContact({ ...contact, [key]: e.target.value })} />}</Field>
  );
  return (
    <StageCard title={t("contact.title")} description={t("contact.description")}>
      <div className="grid gap-4 sm:grid-cols-2">
        {text("name", tProfile("name"), 120)}
        {text("headline", tProfile("headline"), 160)}
        {text("email", tProfile("email"), 200)}
        {text("phone", tProfile("phone"), 60)}
        {text("city", tProfile("city"), 80)}
        <Field label={tProfile("country")}>{(id) => <CountrySelect id={id} value={contact.country || null} emptyLabel={t("notSet")} onChange={(country) => setContact({ ...contact, country: country ?? "" })} />}</Field>
        <Field label={tProfile("links")} className="sm:col-span-2">
          {(id) => <TagInput id={id} value={contact.links} removeLabel={(tag) => tProfile("removeItem", { item: tag })} onChange={(links) => setContact({ ...contact, links })} />}
        </Field>
        <Field label={t("contact.cvLanguage")}>
          {(id) => (
            <Select id={id} value={contact.cvLanguage} onChange={(e) => setContact({ ...contact, cvLanguage: e.target.value as typeof contact.cvLanguage })}>
              {CV_LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t(`languageName.${l}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Actions pending={pending} error={error} onContinue={() => save("contact", contact, true)} />
    </StageCard>
  );
}
