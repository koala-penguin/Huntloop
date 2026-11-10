"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { ArrowRight, Check, Pencil, Plus, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/form";
import { TagInput } from "@/components/ui/tag-input";
import { CountrySelect } from "@/components/ui/country-select";
import { useCountryNames } from "@/components/i18n/country-names";
import { saveStageFormAction } from "@/app/profile/cv-builder/actions";
import { CV_LANGUAGES } from "@/shared/schemas/cv";
import type { CvBuilderForm } from "@/shared/schemas/cv-builder";
import { nextContactQuestion, validEmail, type ContactField } from "@/shared/contact-guide";
import { Field, FieldScope } from "./stage-forms";
import { useNeedLabel } from "./data-stage";

type Contact = CvBuilderForm["contact"];

const INPUTS: Record<ContactField, { type: string; autoComplete: string; inputMode?: "email" | "tel" | "url" | "text"; max: number }> = {
  name: { type: "text", autoComplete: "name", max: 120 },
  email: { type: "email", autoComplete: "email", inputMode: "email", max: 200 },
  phone: { type: "tel", autoComplete: "tel", inputMode: "tel", max: 60 },
  city: { type: "text", autoComplete: "address-level2", max: 80 },
  links: { type: "url", autoComplete: "url", inputMode: "url", max: 300 },
};

/**
 * The contact step as a guided exchange: Huntloop asks for one thing at a time and stores exactly
 * what is typed. No AI is involved, so name, email and phone never leave this machine. Everything
 * entered shows in a summary below, which can be edited as a whole.
 */
export function ContactChat({ cvBuilderId, initial }: { cvBuilderId: number; initial: Contact }) {
  const t = useTranslations("cvBuilder");
  const tProfile = useTranslations("profile");
  const tErrors = useTranslations("errors");
  const need = useNeedLabel();
  const router = useRouter();
  const countries = useCountryNames();
  const [contact, setContact] = useState(initial);
  const [skipped, setSkipped] = useState<ContactField[]>([]);
  const [exchange, setExchange] = useState<Array<{ field: ContactField; question: string; answer: string | null }>>([]);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const asked = useRef(0);

  const field = nextContactQuestion(contact, skipped);
  const firstName = contact.name.trim().split(/\s+/)[0] ?? "";
  const question = field ? t(`contact.ask.${field}`, { name: firstName }) : t("contact.ask.done", { name: firstName });
  const optional = field !== null && field !== "name" && field !== "email";

  // After an answer or a skip the next question's box takes the cursor (it is a new element: its type changes).
  useEffect(() => {
    if (asked.current) input.current?.focus();
  }, [field, exchange.length]);

  const fieldError = (code: string) => (code === "contact.email" ? t("contact.badEmail") : code === "contact.phone" ? t("contact.badPhone") : need(code));
  const save = async (next: Contact, advance = false) => {
    const result = await saveStageFormAction(cvBuilderId, "contact", next, advance);
    if (!result.ok) setProblem(result.error === "stage_incomplete" ? t("stillNeeded", { items: (result.fields ?? []).map(need).join(", ") }) : result.fields?.length ? result.fields.map(fieldError).join(" ") : tErrors("generic", { message: result.error }));
    return result.ok;
  };

  const add = () => {
    const value = text.trim();
    if (!field || !value || pending) return;
    if (field === "email" && !validEmail(value)) return setProblem(t("contact.badEmail"));
    const next: Contact = field === "links" ? { ...contact, links: [...contact.links, value] } : { ...contact, [field]: value };
    start(async () => {
      setProblem(null);
      if (!(await save(next))) return;
      asked.current++;
      setContact(next);
      setExchange((e) => [...e, { field, question, answer: value }]);
      setText("");
      router.refresh();
    });
  };
  const skip = () => {
    if (!field) return;
    asked.current++;
    setProblem(null);
    setExchange((e) => [...e, { field, question, answer: null }]);
    setSkipped((s) => [...s, field]);
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
      e.preventDefault();
      add();
    }
  };
  const saveEdit = () =>
    start(async () => {
      setProblem(null);
      const result = await saveStageFormAction(cvBuilderId, "contact", draft, false);
      if (!result.ok) return setInvalid(result.fields ?? ["contact"]);
      setContact(draft);
      setEditing(false);
      setInvalid([]);
      router.refresh();
    });
  const next = () =>
    start(async () => {
      setProblem(null);
      if (await save(contact, true)) router.refresh();
    });

  const lines: Array<[string, string]> = [
    [tProfile("name"), contact.name],
    [tProfile("headline"), contact.headline],
    [tProfile("email"), contact.email],
    [tProfile("phone"), contact.phone],
    [tProfile("city"), contact.city],
    [tProfile("country"), contact.country ? countries.name(contact.country) : ""],
    [tProfile("links"), contact.links.join(", ")],
    [t("contact.cvLanguage"), t(`languageName.${contact.cvLanguage}`)],
  ];
  const set = (patch: Partial<Contact>) => {
    setDraft({ ...draft, ...patch });
    setInvalid([]);
  };
  const editError = (code: string) => (invalid.includes(code) ? fieldError(code) : null);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">{t("contact.title")}</h2>
        <p className="text-sm text-muted">{t("contact.description")}</p>
      </div>
      <div className="flex flex-col gap-3" aria-live="polite">
        {exchange.map((turn, i) => (
          <div key={i} className="flex flex-col gap-2">
            <p className="text-sm leading-relaxed" data-role="assistant">
              {turn.question}
            </p>
            <p className="max-w-[85%] self-end rounded-lg bg-accent px-3 py-2 text-sm text-accent-foreground" data-role="user">
              {turn.answer ?? t("contact.skippedAnswer")}
            </p>
          </div>
        ))}
      </div>
      {field ? (
        <div className="flex flex-col gap-2" data-contact-question={field}>
          <label htmlFor={`contact-${field}`} className="text-sm leading-relaxed" data-role="assistant">
            {question}
            {optional && <span className="text-muted"> {t("contact.optional")}</span>}
          </label>
          <div className="flex flex-wrap gap-2">
            <Input
              key={field}
              ref={input}
              id={`contact-${field}`}
              className="h-10 min-w-0 flex-1"
              type={INPUTS[field].type}
              autoComplete={INPUTS[field].autoComplete}
              inputMode={INPUTS[field].inputMode}
              maxLength={INPUTS[field].max}
              aria-required={!optional || undefined}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? "contact-problem" : undefined}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setProblem(null);
              }}
              onKeyDown={onKeyDown}
            />
            <Button type="button" size="sm" className="h-10" disabled={pending || !text.trim()} onClick={add}>
              <Plus className="size-3.5" aria-hidden />
              {t("contact.add")}
            </Button>
            {optional && (
              <Button type="button" size="sm" variant="ghost" className="h-10" disabled={pending} onClick={skip}>
                <SkipForward className="size-3.5" aria-hidden />
                {t("skip")}
              </Button>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed" data-role="assistant" data-contact-question="done">
          {question}
        </p>
      )}
      {problem && (
        <Alert tone="danger" role="alert" id="contact-problem">
          {problem}
        </Alert>
      )}

      <section className="flex flex-col gap-2 rounded-md border border-border p-3" data-onfile="contact" aria-label={t("onFile.title")}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t("onFile.title")}</h3>
          {!editing && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-10"
              onClick={() => {
                setDraft(contact);
                setInvalid([]);
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" aria-hidden />
              {t("onFile.edit")}
            </Button>
          )}
        </div>
        {editing ? (
          <FieldScope.Provider value="contact-edit-">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={tProfile("name")}>{(id) => <Input id={id} className="h-10" autoComplete="name" maxLength={120} value={draft.name} onChange={(e) => set({ name: e.target.value })} />}</Field>
              <Field label={tProfile("headline")}>{(id) => <Input id={id} className="h-10" maxLength={160} value={draft.headline} onChange={(e) => set({ headline: e.target.value })} />}</Field>
              <Field label={tProfile("email")} error={editError("contact.email")}>
                {(id, aria) => <Input id={id} className="h-10" type="email" autoComplete="email" maxLength={200} {...aria} value={draft.email} onChange={(e) => set({ email: e.target.value })} />}
              </Field>
              <Field label={tProfile("phone")} error={editError("contact.phone")}>
                {(id, aria) => <Input id={id} className="h-10" type="tel" autoComplete="tel" maxLength={60} {...aria} value={draft.phone} onChange={(e) => set({ phone: e.target.value })} />}
              </Field>
              <Field label={tProfile("city")}>{(id) => <Input id={id} className="h-10" autoComplete="address-level2" maxLength={80} value={draft.city} onChange={(e) => set({ city: e.target.value })} />}</Field>
              <Field label={tProfile("country")}>
                {(id) => <CountrySelect id={id} className="h-10" value={draft.country || null} emptyLabel={t("notSet")} onChange={(country) => set({ country: country ?? "" })} />}
              </Field>
              <Field label={tProfile("links")} className="sm:col-span-2">
                {(id) => <TagInput id={id} value={draft.links} removeLabel={(tag) => tProfile("removeItem", { item: tag })} onChange={(links) => set({ links })} />}
              </Field>
              <Field label={t("contact.cvLanguage")}>
                {(id) => (
                  <Select id={id} className="h-10" value={draft.cvLanguage} onChange={(e) => set({ cvLanguage: e.target.value as Contact["cvLanguage"] })}>
                    {CV_LANGUAGES.map((l) => (
                      <option key={l} value={l}>
                        {t(`languageName.${l}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" className="h-10" disabled={pending} onClick={saveEdit}>
                <Check className="size-3.5" aria-hidden />
                {t("onFile.save")}
              </Button>
              <Button type="button" size="sm" variant="ghost" className="h-10" disabled={pending} onClick={() => setEditing(false)}>
                {t("onFile.cancel")}
              </Button>
            </div>
          </FieldScope.Provider>
        ) : (
          <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
            {lines
              .filter(([, value]) => value)
              .map(([label, value]) => (
                <div key={label} className="contents">
                  <dt className="text-muted">{label}</dt>
                  <dd className="min-w-0 break-words">{value}</dd>
                </div>
              ))}
          </dl>
        )}
      </section>

      <div>
        <Button type="button" size="sm" className="h-10" disabled={pending || editing} onClick={next}>
          <ArrowRight className="size-3.5" aria-hidden />
          {t("continue")}
        </Button>
      </div>
    </Card>
  );
}
