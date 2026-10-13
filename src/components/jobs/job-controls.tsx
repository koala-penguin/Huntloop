"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Check, Loader2, RefreshCw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label, Select, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/badge";
import {
  answerRequirementAction,
  deleteJobAction,
  readFullPostingAction,
  reassessJobAction,
  saveJobTextAction,
  setWorkRightAction,
} from "@/app/jobs/[id]/actions";
import { JobProgress } from "./job-progress";

/** Yes / No / Skip for a requirement Huntloop couldn't settle from the CV. */
export function AnswerButtons({ jobId, requirementId, answer }: { jobId: number; requirementId: string; answer: "yes" | "no" | null }) {
  const t = useTranslations("fit");
  const router = useRouter();
  const [pending, start] = useTransition();
  const send = (value: "yes" | "no" | null) =>
    start(async () => {
      await answerRequirementAction(jobId, requirementId, value);
      router.refresh();
    });

  if (answer) {
    return (
      <span className="flex items-center gap-2 text-sm">
        <span className="text-muted">{answer === "yes" ? t("answeredYes") : t("answeredNo")}</span>
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => send(null)}>
          {t("undoAnswer")}
        </Button>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => send("yes")}>
        <Check className="size-3.5" aria-hidden />
        {t("yes")}
      </Button>
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => send("no")}>
        <X className="size-3.5" aria-hidden />
        {t("no")}
      </Button>
    </span>
  );
}

/** Inline "Do you have work rights in {country}?" — saved to the profile; every job re-tiers instantly. */
export function WorkRightsQuestion({ country, countryLabel, options }: { country: string; countryLabel: string; options: Array<{ id: string; label: string }> }) {
  const t = useTranslations("fit");
  const router = useRouter();
  const [value, setValue] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const id = `work-rights-${country}`;
  return (
    <div className="flex flex-col gap-2 rounded-md bg-accent-soft p-3">
      <Label htmlFor={id}>{t("workRightsQuestion", { country: countryLabel })}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select id={id} value={value} onChange={(e) => setValue(e.target.value)} className="h-8 w-auto max-w-full">
          <option value="" disabled>
            {t("workRightsPlaceholder")}
          </option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
        <Button
          type="button"
          size="sm"
          disabled={!value || pending}
          onClick={() =>
            start(async () => {
              const result = await setWorkRightAction(country, value);
              if (!result.ok) setError(result.error);
              else router.refresh();
            })
          }
        >
          {pending && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {t("workRightsSave")}
        </Button>
      </div>
      <p className="text-xs text-muted">{t("workRightsHint")}</p>
      {error && <Alert tone="danger">{error === "no_profile" ? t("needsProfile") : error}</Alert>}
    </div>
  );
}

/** Starts a background re-assessment (after profile changes) and shows its progress. */
export function ReassessButton({ jobId, label }: { jobId: number; label: string }) {
  const [taskId, setTaskId] = useState<number | null>(null);
  const [pending, start] = useTransition();
  if (taskId) return <JobProgress taskId={taskId} />;
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await reassessJobAction(jobId);
          if (result.ok) setTaskId(result.value.taskId);
        })
      }
    >
      <RefreshCw className="size-3.5" aria-hidden />
      {label}
    </Button>
  );
}

/** Edit the posting text (e.g. fix a screenshot transcription) and re-run the analysis. */
export function PostingTextEditor({ jobId, text }: { jobId: number; text: string }) {
  const t = useTranslations("job");
  const tErrors = useTranslations("errors");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (taskId) return <JobProgress taskId={taskId} />;
  if (!editing) {
    return (
      <div className="flex flex-col gap-3">
        <pre className="max-h-[32rem] overflow-auto rounded-md border border-border bg-surface p-4 font-sans text-sm whitespace-pre-wrap">{text}</pre>
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setValue(text);
              setEditing(true);
            }}
          >
            {t("editText")}
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Label htmlFor={`posting-text-${jobId}`}>{t("editTextLabel")}</Label>
      <Textarea id={`posting-text-${jobId}`} rows={18} value={value} onChange={(e) => setValue(e.target.value)} />
      <p className="text-xs text-muted">{t("editTextHint")}</p>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          disabled={pending || value.trim() === text.trim()}
          onClick={() =>
            start(async () => {
              const result = await saveJobTextAction(jobId, value);
              if (result.ok) setTaskId(result.value.taskId);
              else setError(["posting_too_short", "text_too_long"].includes(result.error) ? tErrors(result.error) : result.error);
            })
          }
        >
          {t("saveText")}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
          {t("cancel")}
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

export function DeleteJobButton({ jobId }: { jobId: number }) {
  const t = useTranslations("job");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  if (!confirming) {
    return (
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
        <Trash2 className="size-3.5" aria-hidden />
        {t("delete")}
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-2 text-sm">
      {t("deleteConfirm")}
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            await deleteJobAction(jobId);
            router.push("/jobs");
          })
        }
      >
        {t("delete")}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
        {t("cancel")}
      </Button>
    </span>
  );
}

/** Translates the report's prose into the UI language once, then refreshes. */
export function TranslateReport({ jobId }: { jobId: number }) {
  const t = useTranslations("fit");
  const locale = useLocale();
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/jobs/${jobId}/translate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ language: locale }) })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) router.refresh();
        else setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [jobId, locale, router]);
  return (
    <p className="flex items-center gap-2 text-xs text-muted" role="status">
      {failed ? (
        t("translateFailed")
      ) : (
        <>
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t("translating")}
        </>
      )}
    </p>
  );
}

/** For jobs found by search: fetch the full posting from its link and analyse it properly. */
export function ReadFullPostingButton({ jobId }: { jobId: number }) {
  const t = useTranslations("job");
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      size="sm"
      disabled={pending}
      onClick={() =>
        start(async () => {
          await readFullPostingAction(jobId);
          router.refresh();
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <RefreshCw className="size-3.5" aria-hidden />}
      {t("readFullPosting")}
    </Button>
  );
}
