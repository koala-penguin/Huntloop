"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Eye, Loader2, Plus, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/form";
import { useTask } from "@/components/tasks/use-task";
import { addWatchAction, checkWatchAction, importMatchesAction, importOpeningAction, removeWatchAction, setAutoCheckAction, watchJobCompanyAction } from "@/app/search/watchlist/actions";

const KNOWN = ["invalid_url", "unsupported_board", "board_unavailable", "not_found", "invalid", "missing_posting"];

function ErrorAlert({ code }: { code: string }) {
  const tErrors = useTranslations("errors");
  return <Alert tone="danger">{KNOWN.includes(code) ? tErrors(code) : tErrors("generic", { message: code })}</Alert>;
}

/** Follows a board check and refreshes the page when it's done. */
function CheckProgress({ taskId, onDone }: { taskId: number; onDone: () => void }) {
  const t = useTranslations("search.watch");
  const router = useRouter();
  const task = useTask(taskId);
  const finished = task && ["succeeded", "failed", "cancelled"].includes(task.status);
  useEffect(() => {
    if (finished) {
      router.refresh();
      onDone();
    }
  }, [finished, router, onDone]);
  return (
    <p className="flex items-center gap-2 text-xs text-muted" role="status" aria-live="polite">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      {t("checking")}
    </p>
  );
}

export function AddWatchForm() {
  const t = useTranslations("search.watch");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const result = await addWatchAction(url);
          if (!result.ok) setError(result.error);
          else {
            setUrl("");
            setTaskId(result.value.taskId);
          }
        });
      }}
    >
      <Label htmlFor="watch-url">{t("urlLabel")}</Label>
      <div className="flex flex-wrap gap-2">
        <Input id="watch-url" className="min-w-0 flex-1" value={url} placeholder="https://boards.greenhouse.io/…" onChange={(e) => setUrl(e.target.value)} />
        <Button type="submit" size="md" disabled={pending || !url.trim()}>
          <Plus className="size-4" aria-hidden />
          {t("add")}
        </Button>
      </div>
      <p className="text-xs text-muted">{t("urlHint")}</p>
      {taskId && <CheckProgress taskId={taskId} onDone={() => setTaskId(null)} />}
      {error && <ErrorAlert code={error} />}
    </form>
  );
}

export function WatchActions({ watchId, autoCheck, matchesToImport }: { watchId: number; autoCheck: boolean; matchesToImport: number }) {
  const t = useTranslations("search.watch");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [taskId, setTaskId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending || taskId !== null}
          onClick={() =>
            start(async () => {
              const result = await checkWatchAction(watchId);
              if (result.ok) setTaskId(result.value.taskId);
            })
          }
        >
          <RefreshCw className="size-3.5" aria-hidden />
          {t("checkNow")}
        </Button>
        {matchesToImport > 0 && (
          <Button
            type="button"
            size="sm"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await importMatchesAction(watchId);
                if (!result.ok) setError(result.error);
                else router.refresh();
              })
            }
          >
            <Sparkles className="size-3.5" aria-hidden />
            {t("importMatches", { count: Math.min(matchesToImport, 10) })}
          </Button>
        )}
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={autoCheck}
            disabled={pending}
            onChange={(e) =>
              start(async () => {
                await setAutoCheckAction(watchId, e.target.checked);
                router.refresh();
              })
            }
          />
          {t("autoCheck")}
        </label>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            start(async () => {
              await removeWatchAction(watchId);
              router.refresh();
            })
          }
        >
          <Trash2 className="size-3.5" aria-hidden />
          {t("remove")}
        </Button>
      </div>
      {matchesToImport > 0 && <p className="text-xs text-muted">{t("importHint")}</p>}
      {taskId && <CheckProgress taskId={taskId} onDone={() => setTaskId(null)} />}
      {error && <ErrorAlert code={error} />}
    </div>
  );
}

export function ImportOpeningButton({ openingId }: { openingId: number }) {
  const t = useTranslations("search.watch");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await importOpeningAction(openingId);
            if (!result.ok) setError(result.error);
            else router.push(`/jobs/${result.value.jobId}`);
          })
        }
      >
        {t("import")}
      </Button>
      {error && <ErrorAlert code={error} />}
    </div>
  );
}

/** On a job: watch its employer's board when Huntloop knows which ATS they use. */
export function WatchEmployerButton({ jobId }: { jobId: number }) {
  const t = useTranslations("search.watch");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <div>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const result = await watchJobCompanyAction(jobId);
              if (!result.ok) setError(result.error);
              else router.refresh();
            })
          }
        >
          <Eye className="size-3.5" aria-hidden />
          {t("watchEmployer")}
        </Button>
      </div>
      {error && <ErrorAlert code={error} />}
    </div>
  );
}
