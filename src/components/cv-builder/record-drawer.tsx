"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { EyeOff, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/form";
import { deleteAnswerAction, editAnswerAction } from "@/app/profile/cv-builder/actions";

export interface RecordedAnswer {
  id: number;
  topic: string;
  quote: string;
  /** The cleaner version they accepted (used on the CV), if any. */
  polished?: string | null;
  private: boolean;
  edited: boolean;
}

export interface RecordGroup {
  key: string;
  label: string;
  answers: RecordedAnswer[];
}

function AnswerItem({ cvBuilderId, answer }: { cvBuilderId: number; answer: RecordedAnswer }) {
  const t = useTranslations("cvBuilder");
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const shown = answer.polished ?? answer.quote;
  const [text, setText] = useState(shown);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      setError(null);
      const result = await fn();
      if (!result.ok) setError(result.error ?? "invalid");
      else {
        setEditing(false);
        router.refresh();
      }
    });
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border p-3" data-answer={answer.id}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>{t(`topic.${answer.topic}`)}</span>
        {answer.private && (
          <Badge tone="outline">
            <EyeOff className="size-3" aria-hidden />
            {t("drawer.private")}
          </Badge>
        )}
        {answer.edited && <Badge tone="outline">{t("drawer.edited")}</Badge>}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea aria-label={t("drawer.editLabel")} value={text} rows={3} maxLength={4000} onChange={(e) => setText(e.target.value)} />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={pending || text.trim().length < 2} onClick={() => act(() => editAnswerAction(cvBuilderId, answer.id, { quote: text }))}>
              {t("drawer.saveEdit")}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
              {t("drawer.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-sm whitespace-pre-wrap">{shown}</p>
          {answer.polished && (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">{t("drawer.original")}</summary>
              <p className="mt-1 whitespace-pre-wrap">{answer.quote}</p>
            </details>
          )}
        </>
      )}
      {!editing && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" aria-hidden />
            {t("drawer.edit")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => act(() => editAnswerAction(cvBuilderId, answer.id, { private: !answer.private }))}>
            {answer.private ? t("drawer.makePublic") : t("drawer.makePrivate")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => act(() => deleteAnswerAction(cvBuilderId, answer.id))}>
            <Trash2 className="size-3.5" aria-hidden />
            {t("drawer.delete")}
          </Button>
        </div>
      )}
      {error && <Alert tone="danger">{t("invalidForm")}</Alert>}
    </li>
  );
}

/** "What I've recorded": every answer, grouped by step and role, editable in the user's own words. */
export function RecordDrawer({ cvBuilderId, groups, open }: { cvBuilderId: number; groups: RecordGroup[]; open: boolean }) {
  const t = useTranslations("cvBuilder");
  const count = groups.reduce((n, g) => n + g.answers.length, 0);
  return (
    <details className="rounded-md border border-border bg-surface p-4" open={open}>
      <summary className="cursor-pointer text-sm font-medium">{t("drawer.title", { count })}</summary>
      <p className="mt-2 text-xs text-muted">{t("drawer.description")}</p>
      {count === 0 ? (
        <p className="mt-3 text-sm text-muted">{t("drawer.empty")}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          {groups
            .filter((g) => g.answers.length)
            .map((g) => (
              <section key={g.key} className="flex flex-col gap-2">
                <h3 className="text-xs font-medium text-muted">{g.label}</h3>
                <ul className="flex flex-col gap-2">
                  {g.answers.map((a) => (
                    <AnswerItem key={`${a.id}:${a.polished ?? a.quote}:${a.private}`} cvBuilderId={cvBuilderId} answer={a} />
                  ))}
                </ul>
              </section>
            ))}
        </div>
      )}
    </details>
  );
}
