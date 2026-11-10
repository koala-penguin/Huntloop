"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/badge";
import { useCountryNames } from "@/components/i18n/country-names";
import { resolveChatActionAction } from "@/app/jobs/[id]/actions";
import { acceptFormCardAction } from "@/app/profile/cv-builder/actions";
import type { FormCardStage, FormCardValue } from "@/shared/schemas/cv-builder";
import { CurrentFields, EducationRows, FieldScope, LanguageRows, RoleRows, SetupFields, TargetFields, type FieldFlags } from "./stage-forms";

/** What the editors need to know about the CV-builder session: the target market, the CV's language, the depth. */
export interface CardContext {
  country: string;
  cvLanguage: string;
  quick: boolean;
}

/** The fields of one step, for a card in the chat and (`full`: with the picks a chat never sets) for the "On file" editor. */
export function FormCardEditor({
  stage,
  value,
  onChange,
  flags,
  context,
  full = false,
}: {
  stage: FormCardStage;
  value: FormCardValue;
  onChange: (next: FormCardValue) => void;
  flags: FieldFlags;
  context: CardContext;
  full?: boolean;
}) {
  const scope = useId();
  return (
    <FieldScope.Provider value={scope}>
      {stage === "setup" && <SetupFields value={value as FormCardValue<"setup">} onChange={onChange} flags={flags} picks={full} />}
      {stage === "target" && <TargetFields value={value as FormCardValue<"target">} onChange={onChange} country={context.country} flags={flags} />}
      {stage === "current" && <CurrentFields value={value as FormCardValue<"current">} onChange={onChange} flags={flags} />}
      {stage === "roles" && <RoleRows value={(value as FormCardValue<"roles">).roles} onChange={(roles) => onChange({ roles })} quick={context.quick} flags={flags} />}
      {stage === "education" && <EducationRows value={value as FormCardValue<"education">} onChange={onChange} />}
      {stage === "languages" && <LanguageRows value={(value as FormCardValue<"languages">).languages} onChange={(languages) => onChange({ languages })} cvLanguage={context.cvLanguage} flags={flags} />}
    </FieldScope.Provider>
  );
}

/** One line per saved thing: "Head of Data, PB · 2021-03 – present". */
export function useSummaryLines(): (stage: FormCardStage, value: FormCardValue) => string[] {
  const t = useTranslations("cvBuilder");
  const tProfile = useTranslations("profile");
  const join = (...parts: Array<string | null | undefined>) => parts.filter((p) => p && p.trim()).join(" · ");
  const both = (a: string | null | undefined, b: string | null | undefined) => [a, b].filter((p) => p && p.trim()).join(", ");
  const countries = useCountryNames();
  return (stage, value) => {
    switch (stage) {
      case "setup": {
        const v = value as FormCardValue<"setup">;
        return [v.personas.length ? v.personas.map((p) => t(`persona.${p}`)).join(", ") : t("setup.noPersona"), join(t(`languageName.${v.language}`), countries.name(v.country), t(`depth.${v.depth}`))];
      }
      case "target": {
        const v = value as FormCardValue<"target">;
        return [join(v.titles.join(", "), v.industries.join(", "), v.cities.join(", "), v.availability)].filter(Boolean);
      }
      case "current": {
        const v = value as FormCardValue<"current">;
        return v.title || v.status !== "employed" ? [join(t(`currentStatus.${v.status}`), both(v.title, v.company), v.start ? t("onFile.since", { start: v.start }) : "")] : [];
      }
      case "roles":
        return (value as FormCardValue<"roles">).roles.map((r) => join(both(r.title || t("untitledRole"), r.company), r.start || r.end || r.current ? `${r.start || "?"} – ${r.current ? t("onFile.present") : r.end || "?"}` : ""));
      case "education": {
        const v = value as FormCardValue<"education">;
        return [
          ...v.education.map((e) => join(both([e.degree, e.field].filter(Boolean).join(" "), e.institution), [e.start, e.end].filter(Boolean).join(" – "))),
          ...v.certifications.map((c) => join(both(c.name, c.issuer), c.year)),
        ];
      }
      case "languages":
        return (value as FormCardValue<"languages">).languages.map((l) => join(l.language, l.level ? tProfile(`languageLevel.${l.level}`) : ""));
    }
  };
}

/** A field left out of a card, in words: "the start date of role 2". */
function useLeftOut() {
  const t = useTranslations("chat.card");
  return (path: string) => {
    const [group, index, field] = path.split(".");
    if (field === undefined) return t(`field.${group}`);
    return t("leftOutOf", { field: t(`field.${field}`), row: t(`row.${group}`, { n: Number(index) + 1 }) });
  };
}

interface FormPayload {
  stage: FormCardStage;
  value: FormCardValue;
  inferred?: string[];
  unresolved?: string[];
  dropped?: string[];
  replaced?: boolean;
}

/**
 * What the interviewer read from the candidate's messages, as a card to check: every field can be
 * changed, "Use this" saves what the card shows, "Not right" saves nothing. Only the newest card of
 * a chat can be used; an older one shows as replaced.
 */
export function FormProposalCard({
  action,
  cvBuilderId,
  context,
  newest,
  onDone,
}: {
  action: { id: number; kind: string; status: string; payload: Record<string, unknown> };
  cvBuilderId: number;
  context: CardContext;
  /** Whether this is the chat's newest card (the only one that can be used). */
  newest: boolean;
  /** After the card is used or dismissed: the chat puts the cursor back in the reply box. */
  onDone?: () => void;
}) {
  const t = useTranslations("chat.card");
  const router = useRouter();
  const titleId = useId();
  const root = useRef<HTMLDivElement>(null);
  const payload = action.payload as unknown as FormPayload;
  const [value, setValue] = useState<FormCardValue>(payload.value);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const lines = useSummaryLines()(payload.stage, action.status === "pending" ? value : payload.value);
  const leftOut = useLeftOut();
  const usable = action.status === "pending" && newest;

  // After a refused save, the cursor goes to the first field that needs fixing.
  useEffect(() => {
    if (invalid.length) root.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [invalid]);

  const finish = () => {
    onDone?.();
    router.refresh();
  };
  const use = () =>
    start(async () => {
      setError(null);
      const result = await acceptFormCardAction(cvBuilderId, action.id, value);
      if (result.ok) return finish();
      if (result.error === "invalid") {
        setInvalid(result.fields ?? []);
        setError(t("formInvalid"));
      } else {
        setError(result.error === "card_replaced" ? t("formReplaced") : result.error);
        router.refresh();
      }
    });
  const dismiss = () =>
    start(async () => {
      const result = await resolveChatActionAction(action.id, "dismiss");
      if (!result.ok) setError(result.error);
      finish();
    });

  return (
    <div
      ref={root}
      role="group"
      aria-labelledby={titleId}
      // An editable form inside the transcript's live region would be announced on every change.
      aria-live="off"
      className="flex flex-col gap-3 rounded-md border border-accent/40 bg-accent-soft p-3"
      data-action={action.kind}
      data-stage={payload.stage}
      data-status={action.status}
    >
      <p id={titleId} className="text-sm font-medium">
        {t(`formTitle.${payload.stage}`)}
      </p>
      {usable ? (
        <>
          <p className="text-xs text-muted">{t("formHint")}</p>
          <FormCardEditor
            stage={payload.stage}
            value={value}
            onChange={(next) => {
              setValue(next);
              setInvalid([]);
            }}
            flags={{ inferred: payload.inferred ?? [], invalid }}
            context={context}
          />
          {(payload.dropped ?? []).length > 0 && <p className="text-xs text-muted">{t("formLeftOut", { items: (payload.dropped ?? []).map(leftOut).join(", ") })}</p>}
          {error && (
            <Alert tone="danger" role="alert">
              {error}
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" className="h-10" disabled={pending} onClick={use}>
              <Check className="size-3.5" aria-hidden />
              {t("formUse")}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="h-10" disabled={pending} onClick={dismiss}>
              <X className="size-3.5" aria-hidden />
              {t("formDismiss")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <ul className="flex flex-col gap-1 text-sm" data-card-summary>
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <Badge tone={action.status === "accepted" ? "accent" : "outline"} className="self-start">
            {action.status === "accepted" ? t("formSaved") : action.status === "pending" || payload.replaced ? t("formReplaced") : t("formDismissed")}
          </Badge>
        </>
      )}
    </div>
  );
}
