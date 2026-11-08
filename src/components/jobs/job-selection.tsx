"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/badge";
import { chunkIds, deletableCount } from "@/shared/schemas/job";
import type { DeleteJobsResult } from "@/server/repo/jobs";

type ListedJob = { id: number; inProgress: boolean };

interface Selection {
  jobs: ListedJob[];
  selected: Set<number>;
  toggle: (id: number, on: boolean) => void;
  setAll: (on: boolean) => void;
  remove: (ids: number[]) => void;
  /** A bulk delete is running: every checkbox is locked until it ends. */
  pending: boolean;
  startTransition: (action: () => Promise<void>) => void;
}

const SelectionContext = createContext<Selection | null>(null);

function useSelection(): Selection {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("JobSelectionProvider is missing");
  return ctx;
}

/** Holds which of the listed jobs are ticked; the rows themselves stay server-rendered. */
export function JobSelectionProvider({ jobs, children }: { jobs: ListedJob[]; children: ReactNode }) {
  const [ticked, setSelected] = useState<Set<number>>(() => new Set());
  // After a refresh, ids that are no longer listed don't count as selected.
  const selected = useMemo(() => new Set(jobs.map((j) => j.id).filter((id) => ticked.has(id))), [jobs, ticked]);

  const toggle = useCallback((id: number, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const setAll = useCallback((on: boolean) => setSelected(on ? new Set(jobs.map((j) => j.id)) : new Set()), [jobs]);
  const remove = useCallback((ids: number[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, []);

  const [pending, startTransition] = useTransition();
  const value = useMemo(
    () => ({ jobs, selected, toggle, setAll, remove, pending, startTransition }),
    [jobs, selected, toggle, setAll, remove, pending, startTransition],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}

/** The per-row checkbox. A sibling of the row link, never inside it. */
export function JobSelectCheckbox({ id, label }: { id: number; label: string }) {
  const { selected, toggle, pending } = useSelection();
  return (
    <input type="checkbox" className="size-4 shrink-0" aria-label={label} checked={selected.has(id)} disabled={pending} onChange={(e) => toggle(id, e.target.checked)} />
  );
}

/** `focus`: the panel closed because of this result, so keyboard focus moves here instead of falling to <body>. */
type Notice = { tone: "neutral" | "danger"; text: string; focus?: boolean };

/** Select-all, the selection count, "Delete selected" and its confirm panel. */
export function BulkActionsBar() {
  const t = useTranslations("jobs.bulk");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const { jobs, selected, setAll, remove, pending, startTransition } = useSelection();
  const [confirming, setConfirming] = useState(false);
  const [includeInProgress, setIncludeInProgress] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const busyRef = useRef(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const openRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);
  const noticeRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();

  const selectedRows = jobs.filter((j) => selected.has(j.id));
  const count = selectedRows.length;
  const inProgressCount = selectedRows.filter((j) => j.inProgress).length;
  const toDelete = deletableCount(selectedRows, includeInProgress);
  const allSelected = jobs.length > 0 && count === jobs.length;

  // Unticking everything closes the panel for good: ticking a row later must not bring it back unasked
  // (with a stale "also delete in progress" choice and focus left elsewhere).
  if (confirming && count === 0 && !pending) setConfirming(false);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = count > 0 && count < jobs.length;
  }, [count, jobs.length]);

  // Focus Cancel when the panel opens (an accidental Enter cancels); back to "Delete selected" when it closes.
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (wasConfirming.current) openRef.current?.focus();
    wasConfirming.current = confirming;
  }, [confirming]);

  // Runs after the effect above, so a finished delete leaves focus on its result.
  useEffect(() => {
    if (notice?.focus) noticeRef.current?.focus();
  }, [notice]);

  const close = useCallback(() => {
    if (!pending && !busyRef.current) setConfirming(false);
  }, [pending]);

  // While the panel is open, Escape closes it wherever focus is (the bar, a row checkbox, the panel).
  useEffect(() => {
    if (!confirming) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming, close]);

  const confirm = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    const ids = selectedRows.map((j) => j.id);
    startTransition(async () => {
      try {
        const deleted: number[] = [];
        let kept = 0;
        let gone = 0;
        for (const chunk of chunkIds(ids)) {
          let result: DeleteJobsResult | null = null;
          try {
            const res = await fetch("/api/jobs", {
              method: "DELETE",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ids: chunk, includeInProgress }),
            });
            if (res.ok) result = (await res.json()) as DeleteJobsResult;
          } catch {
            result = null;
          }
          if (!result) {
            if (deleted.length) {
              setNotice({ tone: "danger", text: t("partialFailed", { count: deleted.length }), focus: true });
              remove(deleted);
              setConfirming(false);
              router.refresh();
            } else {
              setNotice({ tone: "danger", text: t("failed") });
            }
            return;
          }
          deleted.push(...result.deleted);
          kept += result.skipped.filter((s) => s.reason === "in_progress").length;
          gone += result.skipped.filter((s) => s.reason === "not_found").length;
        }
        const parts = [t("done", { count: deleted.length })];
        if (kept > 0) parts.push(t("keptInProgress", { count: kept }));
        if (gone > 0) parts.push(t("alreadyGone", { count: gone }));
        setNotice({ tone: "neutral", text: parts.join(" "), focus: true });
        setAll(false);
        setConfirming(false);
        router.refresh();
      } finally {
        busyRef.current = false;
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      {jobs.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <input
            ref={selectAllRef}
            type="checkbox"
            className="size-4"
            aria-label={t("selectAll", { count: jobs.length })}
            checked={allSelected}
            disabled={pending}
            onChange={() => setAll(!allSelected)}
          />
          <span role="status" className="text-muted">
            {t("selected", { count })}
          </span>
          <Button
            ref={openRef}
            type="button"
            variant="danger"
            size="sm"
            disabled={count === 0 || pending}
            onClick={() => {
              setIncludeInProgress(false);
              setNotice(null);
              setConfirming(true);
            }}
          >
            <Trash2 className="size-3.5" aria-hidden />
            {t("deleteSelected")}
          </Button>
        </div>
      )}
      {confirming && count > 0 && (
        <div
          role="alertdialog"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          className="flex flex-col gap-3 rounded-md border border-danger/40 bg-danger-soft p-3 text-sm"
        >
          {toDelete > 0 ? (
            <>
              <p id={titleId} className="font-medium">
                {t("confirmTitle", { count: toDelete })}
              </p>
              <p id={bodyId}>{t("confirmBody")}</p>
            </>
          ) : (
            <p id={titleId} className="font-medium">
              <span id={bodyId}>{t("nothingToDelete")}</span>
            </p>
          )}
          {inProgressCount > 0 && (
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-2">
                <input type="checkbox" className="size-4" checked={includeInProgress} disabled={pending} onChange={(e) => setIncludeInProgress(e.target.checked)} />
                {t("includeInProgress", { count: inProgressCount })}
              </label>
              <p className="text-xs text-muted">{t("inProgressKept")}</p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="danger" size="sm" disabled={pending || toDelete === 0} onClick={confirm}>
              {t("confirmDelete")}
            </Button>
            <Button ref={cancelRef} type="button" variant="ghost" size="sm" disabled={pending} onClick={close}>
              {tCommon("cancel")}
            </Button>
          </div>
        </div>
      )}
      {notice && (
        <Alert ref={noticeRef} tabIndex={-1} tone={notice.tone}>
          {notice.text}
        </Alert>
      )}
    </div>
  );
}
