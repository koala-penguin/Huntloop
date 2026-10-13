"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { FileText, ImagePlus, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldHint, Label, Textarea } from "@/components/ui/form";
import { Alert } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

import { AI_ERROR_CODES } from "@/shared/ai-errors";
const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,application/pdf";
const MAX_FILES = 12;
const KNOWN_ERRORS = [
  "missing_posting",
  "posting_too_short",
  "invalid_url",
  "too_many_files",
  "file_too_large",
  "unsupported_posting_file",
  "text_too_long",
  "not_found", ...AI_ERROR_CODES];

interface Picked {
  file: File;
  preview: string | null;
}

/**
 * One box for a job: a link, the posting's text, and/or screenshots (drop, choose or paste with
 * Ctrl/⌘+V) or a PDF. With `jobId` it adds content to an existing job instead of creating one.
 */
export function PostingInput({ jobId, autoFocus }: { jobId?: number; autoFocus?: boolean }) {
  const t = useTranslations("addJob");
  const tErrors = useTranslations("errors");
  const router = useRouter();
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Picked[]>([]);
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const inputId = jobId ? `job-${jobId}-content` : "add-job-text";

  // Previews are object URLs: release them when removed and when the box goes away.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const created = previews.current;
    return () => created.forEach((url) => URL.revokeObjectURL(url));
  }, []);
  const preview = (file: File) => {
    if (!file.type.startsWith("image/")) return null;
    const url = URL.createObjectURL(file);
    previews.current.add(url);
    return url;
  };
  const removeAt = (index: number) =>
    setFiles((current) => {
      const gone = current[index]?.preview;
      if (gone) {
        URL.revokeObjectURL(gone);
        previews.current.delete(gone);
      }
      return current.filter((_, j) => j !== index);
    });

  const addFiles = (list: FileList | File[]) => {
    const accepted = Array.from(list).filter((f) => f.type.startsWith("image/") || f.type === "application/pdf");
    if (!accepted.length) return;
    setFiles((current) =>
      [...current, ...accepted.slice(0, Math.max(0, MAX_FILES - current.length)).map((file) => ({ file, preview: preview(file) }))],
    );
  };

  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files);
    if (pasted.length) {
      e.preventDefault();
      addFiles(pasted);
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const form = new FormData();
      form.set("text", text);
      files.forEach((f) => form.append("files", f.file));
      const res = await fetch(jobId ? `/api/jobs/${jobId}/content` : "/api/jobs", { method: "POST", body: form });
      const body = (await res.json()) as { jobId?: number; taskId?: number; duplicate?: boolean; error?: string };
      if (!res.ok) {
        setError(body.error && KNOWN_ERRORS.includes(body.error) ? tErrors(body.error) : tErrors("generic", { message: body.error ?? res.statusText }));
        return;
      }
      if (jobId) {
        setText("");
        setFiles([]);
        router.refresh();
      } else {
        router.push(`/jobs/${body.jobId}${body.duplicate ? "?duplicate=1" : ""}`);
      }
    } catch (e) {
      setError(tErrors("generic", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSubmitting(false);
    }
  };

  const empty = !text.trim() && files.length === 0;

  return (
    <div
      className={cn("flex flex-col gap-3 rounded-lg border border-dashed border-border p-4 transition-colors", dragging && "border-accent bg-accent-soft")}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <Label htmlFor={inputId}>{jobId ? t("contentLabel") : t("label")}</Label>
      <Textarea
        id={inputId}
        rows={jobId ? 6 : 4}
        value={text}
        autoFocus={autoFocus}
        disabled={submitting}
        onChange={(e) => setText(e.target.value)}
        onPaste={onPaste}
        placeholder={jobId ? t("contentPlaceholder") : t("placeholder")}
      />

      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={t("filesLabel")}>
          {files.map((f, i) => (
            <li key={`${f.file.name}-${i}`} className="relative flex h-20 w-28 items-center justify-center overflow-hidden rounded-md border border-border bg-surface">
              {f.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- local object URL preview
                <img src={f.preview} alt={f.file.name} className="h-full w-full object-cover object-top" />
              ) : (
                <span className="flex flex-col items-center gap-1 px-2 text-center text-xs text-muted">
                  <FileText className="size-5" aria-hidden />
                  <span className="line-clamp-2 break-all">{f.file.name}</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => removeAt(i)}
                className="absolute top-1 right-1 rounded-full bg-surface/90 p-0.5 shadow hover:bg-danger-soft"
                aria-label={t("remove", { name: f.file.name })}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <FieldHint>{t("hint")}</FieldHint>

      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          id={`${inputId}-files`}
          aria-label={t("chooseFiles")}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <Button type="button" variant="secondary" size="sm" onClick={() => fileInput.current?.click()} disabled={submitting || files.length >= MAX_FILES}>
          <ImagePlus className="size-4" aria-hidden />
          {t("chooseFiles")}
        </Button>
        <Button type="button" size="sm" onClick={submit} disabled={submitting || empty}>
          {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
          {jobId ? t("submitContent") : t("submit")}
        </Button>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
