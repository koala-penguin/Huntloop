"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Check, Copy, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/form";
import { useTask } from "@/components/tasks/use-task";
import { generateLinkedinAction } from "@/app/cv/actions";
import { FlagCard, type FlaggedLine } from "./flag-card";

export interface LinkedinSection {
  key: string;
  label: string;
  text: string;
  limit: number | null;
  blocked: boolean;
}

function CopyButton({ text, label, disabled }: { text: string; label: string; disabled: boolean }) {
  const t = useTranslations("linkedin");
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      disabled={disabled}
      aria-label={t("copyLabel", { section: label })}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      {copied ? t("copied") : t("copy")}
    </Button>
  );
}

function Progress({ taskId }: { taskId: number }) {
  const t = useTranslations("linkedin");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const task = useTask(taskId);
  useEffect(() => {
    if (task?.status === "succeeded") router.refresh();
  }, [task?.status, router]);
  if (task?.status === "failed") {
    const known = ["no_profile", "refusal", "budget", "invalid_output", "max_tokens"];
    return <Alert tone="danger">{task.errorCode && known.includes(task.errorCode) ? tErrors(task.errorCode) : tErrors("generic", { message: task.errorMessage ?? "" })}</Alert>;
  }
  return (
    <p className="flex items-center gap-2 text-sm text-muted" role="status" aria-live="polite">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {t("writing")}
    </p>
  );
}

/** Profile → LinkedIn: profile text for the target roles, checked like a CV, copied section by section. */
export function LinkedinPanel({
  doc,
  sections,
  flagged,
  stale,
  blocking,
  defaultLanguage,
}: {
  doc: { id: number; version: number; language: string } | null;
  sections: LinkedinSection[];
  flagged: FlaggedLine[];
  stale: boolean;
  blocking: number;
  defaultLanguage: "en" | "ko";
}) {
  const t = useTranslations("linkedin");
  const tErrors = useTranslations("errors");
  const [language, setLanguage] = useState<string>(doc?.language ?? defaultLanguage);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <div className="flex flex-col gap-3">
          {stale && doc && <Alert>{t("stale")}</Alert>}
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="linkedin-language">{t("language")}</Label>
              <Select id="linkedin-language" value={language} className="h-8 w-auto" onChange={(e) => setLanguage(e.target.value)}>
                <option value="en">{t("languages.en")}</option>
                <option value="ko">{t("languages.ko")}</option>
              </Select>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={pending || taskId !== null}
              onClick={() =>
                start(async () => {
                  setError(null);
                  const result = await generateLinkedinAction(language);
                  if (!result.ok) setError(result.error);
                  else setTaskId(result.value.taskId);
                })
              }
            >
              <Sparkles className="size-3.5" aria-hidden />
              {doc ? t("regenerate") : t("generate")}
            </Button>
          </div>
          <p className="text-xs text-muted">{t("costHint")}</p>
          {taskId && <Progress taskId={taskId} />}
          {error && <Alert tone="danger">{error === "no_profile" ? tErrors("no_profile") : tErrors("generic", { message: error })}</Alert>}
          {doc && blocking > 0 && <Alert>{t("blocking", { count: blocking })}</Alert>}
        </div>
      </Card>

      {doc && flagged.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("checkTitle")}</CardTitle>
            <CardDescription>{t("checkDescription")}</CardDescription>
          </CardHeader>
          <ul className="flex flex-col gap-3">
            {flagged.map((line) => (
              <FlagCard key={`${line.id}:${line.text}`} docId={doc.id} line={line} />
            ))}
          </ul>
        </Card>
      )}

      {doc &&
        sections.map((s) => (
          <Card key={s.key} data-linkedin-section={s.key}>
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-medium">{s.label}</h3>
                <div className="flex items-center gap-3">
                  {s.limit !== null && (
                    <span className={`text-xs ${s.text.length > s.limit ? "text-danger" : "text-muted"}`}>{t("counter", { length: s.text.length, limit: s.limit })}</span>
                  )}
                  <CopyButton text={s.text} label={s.label} disabled={s.blocked} />
                </div>
              </div>
              <p className="text-sm whitespace-pre-line">{s.text}</p>
              {s.blocked && <p className="text-xs text-warning">{t("copyBlocked")}</p>}
            </div>
          </Card>
        ))}
    </div>
  );
}
