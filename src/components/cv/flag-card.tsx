"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { BadgeCheck, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/form";
import { resolveCvLineAction } from "@/app/cv/actions";
import type { CvFlag, LineOrigin } from "@/shared/schemas/cv";

export interface FlaggedLine {
  id: string;
  text: string;
  origin: LineOrigin;
  /** Where the line sits, e.g. "Summary" or "Senior Frontend Engineer — Harbour Payments". */
  where: string;
  sources: Array<{ source: "cv" | "fact"; quote: string; verified: boolean }>;
  flags: CvFlag[];
  /** Headlines can be edited but not removed. */
  removable: boolean;
}

/** A line Huntloop couldn't trace to the CV or confirmed facts, and the three ways to resolve it. */
export function FlagCard({ docId, line }: { docId: number; line: FlaggedLine }) {
  const t = useTranslations("cv");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(line.text);
  const [error, setError] = useState<string | null>(null);
  const blocking = line.flags.some((f) => f.severity === "block");

  const act = (action: { kind: "remove" } | { kind: "edit"; text: string } | { kind: "confirm_fact" }) =>
    start(async () => {
      setError(null);
      const result = await resolveCvLineAction(docId, line.id, action);
      if (!result.ok) setError(result.error);
      else {
        setEditing(false);
        router.refresh();
      }
    });

  return (
    <li className={`flex flex-col gap-2 rounded-md border p-3 ${blocking ? "border-warning/50 bg-warning-soft" : "border-border"}`} data-flagged-line={line.id}>
      <p className="text-xs text-muted">{line.where}</p>
      <p className="text-sm">{line.text}</p>
      <ul className="flex flex-col gap-0.5 text-xs">
        {line.flags.map((f) => (
          <li key={f.id} className={f.severity === "block" ? "text-warning" : "text-muted"}>
            {t(`flag.${f.kind}`, f.params)}
          </li>
        ))}
      </ul>
      {line.sources.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{t("sources", { count: line.sources.length })}</summary>
          <ul className="mt-1 flex flex-col gap-1">
            {line.sources.map((s, i) => (
              <li key={i}>
                {t(s.verified ? "sourceFound" : "sourceMissing", { source: t(`sourceKind.${s.source}`), quote: s.quote })}
              </li>
            ))}
          </ul>
        </details>
      )}
      {line.origin === "user" && <p className="text-xs text-muted">{t("yourWords")}</p>}
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea aria-label={t("editLabel")} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={600} />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={pending || !text.trim()} onClick={() => act({ kind: "edit", text })}>
              {t("saveEdit")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {line.removable && (
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => act({ kind: "remove" })}>
              <Trash2 className="size-3.5" aria-hidden />
              {t("remove")}
            </Button>
          )}
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden />
            {t("edit")}
          </Button>
          {blocking && (
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => act({ kind: "confirm_fact" })}>
              <BadgeCheck className="size-3.5" aria-hidden />
              {t("confirmFact")}
            </Button>
          )}
        </div>
      )}
      {error && <Alert tone="danger">{["not_found", "no_profile"].includes(error) ? tErrors(error) : tErrors("generic", { message: error })}</Alert>}
    </li>
  );
}
