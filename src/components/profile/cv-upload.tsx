"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Label, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/badge";
import { useTask } from "@/components/tasks/use-task";

import { AI_ERROR_CODES } from "@/shared/ai-errors";
const KNOWN_ERRORS = ["unsupported_file", "file_too_large", "text_too_long", "cv_too_short", "missing_input", "refusal", "budget", "invalid_output", "max_tokens", ...AI_ERROR_CODES];

export function CvUpload({ replacing }: { replacing: boolean }) {
  const t = useTranslations("profile.upload");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const task = useTask(taskId);
  const fileInput = useRef<HTMLInputElement>(null);

  // A file chosen before the page finished loading never fired onChange; pick it up now.
  useEffect(() => {
    const chosen = fileInput.current?.files?.[0];
    if (chosen) setFile(chosen);
  }, []);

  useEffect(() => {
    if (task?.status === "succeeded") router.refresh();
  }, [task?.status, router]);

  const describeError = (code: string | null, message: string | null) =>
    code && KNOWN_ERRORS.includes(code) ? tErrors(code) : tErrors("generic", { message: message ?? "" });

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const form = new FormData();
      if (file) form.set("file", file);
      else form.set("text", text);
      const res = await fetch("/api/cv", { method: "POST", body: form });
      const body = (await res.json()) as { taskId?: number; error?: string };
      if (!res.ok || !body.taskId) setError(describeError(body.error ?? null, null));
      else setTaskId(body.taskId);
    } catch (e) {
      setError(describeError(null, e instanceof Error ? e.message : String(e)));
    } finally {
      setSubmitting(false);
    }
  };

  const working = submitting || (task !== null && !["succeeded", "failed", "cancelled"].includes(task.status)) || (taskId !== null && task === null);
  const stage = (task?.progress as { stage?: string } | null)?.stage;
  const failed = task?.status === "failed" ? describeError(task.errorCode, task.errorMessage) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{replacing ? t("replaceTitle") : t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Label htmlFor="cv-file">{t("fileLabel")}</Label>
          <input
            id="cv-file"
            ref={fileInput}
            type="file"
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            disabled={working}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm hover:file:bg-accent-soft"
          />
          <FieldHint>{t("fileHint")}</FieldHint>
        </div>

        {!file && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="cv-text">{t("pasteLabel")}</Label>
            <Textarea id="cv-text" rows={6} value={text} disabled={working} onChange={(e) => setText(e.target.value)} placeholder={t("pastePlaceholder")} />
          </div>
        )}

        <FieldHint>{t("privacy")}</FieldHint>

        <div className="flex items-center gap-3">
          <Button type="button" onClick={submit} disabled={working || (!file && text.trim().length === 0)}>
            {working ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FileUp className="size-4" aria-hidden />}
            {working ? t("working") : t("submit")}
          </Button>
          {working && <span className="text-sm text-muted">{stage === "analyzing" ? t("stageAnalyzing") : t("stageReading")}</span>}
        </div>

        {(error || failed) && <Alert tone="danger">{error ?? failed}</Alert>}
        {task?.status === "succeeded" && <Alert tone="neutral">{t("done")}</Alert>}
      </div>
    </Card>
  );
}
