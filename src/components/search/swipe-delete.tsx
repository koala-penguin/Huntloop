"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Trash2 } from "lucide-react";
import type { DeleteJobsResult } from "@/server/repo/jobs";
import { SWIPE_ANIMATION_MS, useSwipeLeft } from "./use-swipe-left";

/** How long "Deleted · Undo" stays up before the delete is sent. */
export const UNDO_MS = 5000;

type Notice = "failed" | "kept";

interface SwipeDelete {
  hidden: ReadonlySet<number>;
  swiped: (id: number) => void;
}

const SwipeDeleteContext = createContext<SwipeDelete | null>(null);

/**
 * Jobs whose delete has been sent in this tab. A delete sent while the list unmounts gets no refresh, and
 * Back can show the list from the router's client cache, rendered before the delete; these stay hidden.
 */
const sentDeletes = new Set<number>();

/**
 * Sends the delete through the bulk-delete route (DELETE /api/jobs, in-progress jobs kept), with `keepalive`
 * so a delete sent while the page is being left still reaches the server.
 */
async function sendDelete(id: number): Promise<DeleteJobsResult | null> {
  try {
    const res = await fetch("/api/jobs", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids: [id], includeInProgress: false }),
      keepalive: true,
    });
    return res.ok ? ((await res.json()) as DeleteJobsResult) : null;
  } catch {
    return null;
  }
}

/**
 * Swipe-to-delete for the search results list. A swiped row is hidden at once and its delete waits UNDO_MS
 * behind an Undo toast. A second swipe sends the first one's delete straight away. Leaving the page sends
 * any waiting delete immediately: client navigation unmounts this provider; a reload, tab close or full
 * navigation fires `pagehide`; switching apps or locking the phone hides the page (iOS may then discard
 * the tab without any further event). So a swipe is never silently lost.
 */
export function SwipeDeleteProvider({ children }: { children: ReactNode }) {
  const t = useTranslations("search.swipe");
  const router = useRouter();
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set(sentDeletes));
  /** The row the Undo button would restore. */
  const [undoId, setUndoId] = useState<number | null>(null);
  /** A delete that didn't go through; shown next to (never instead of) a waiting Undo. */
  const [notice, setNotice] = useState<Notice | null>(null);
  const pending = useRef<{ id: number; timer: number } | null>(null);
  const mounted = useRef(true);
  const restoreFocus = useRef<number | null>(null);

  const show = useCallback((id: number, on: boolean) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const commit = useCallback(
    (id: number) => {
      sentDeletes.add(id);
      void sendDelete(id).then((result) => {
        const kept = result?.skipped.some((s) => s.id === id && s.reason === "in_progress");
        if (!result || kept) sentDeletes.delete(id);
        if (!mounted.current) return;
        if (!result) {
          show(id, true);
          setNotice("failed");
        } else if (kept) {
          show(id, true);
          setNotice("kept");
        } else {
          router.refresh();
        }
      });
    },
    [router, show],
  );

  /** Sends the waiting delete now (another swipe, or the page is going away). */
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    window.clearTimeout(p.timer);
    setUndoId((current) => (current === p.id ? null : current));
    commit(p.id);
  }, [commit]);

  const swiped = useCallback(
    (id: number) => {
      flush();
      show(id, false);
      const timer = window.setTimeout(() => {
        if (pending.current?.id === id) flush();
      }, UNDO_MS);
      pending.current = { id, timer };
      setUndoId(id);
    },
    [flush, show],
  );

  const undo = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    window.clearTimeout(p.timer);
    restoreFocus.current = p.id;
    show(p.id, true);
    setUndoId(null);
  }, [show]);

  // The Undo button disappears with the toast; put focus back on the restored row instead of <body>.
  useEffect(() => {
    const id = restoreFocus.current;
    if (id === null || hidden.has(id)) return;
    restoreFocus.current = null;
    document.querySelector<HTMLElement>(`[data-result="${id}"]`)?.focus();
  }, [hidden]);

  // A failure notice goes away on its own.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), UNDO_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Listeners and the unmount flush are attached once; they always call the latest `flush`.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);
  useEffect(() => {
    mounted.current = true;
    const leave = () => flushRef.current();
    const hide = () => {
      if (document.visibilityState === "hidden") leave();
    };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", hide);
    return () => {
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", hide);
      mounted.current = false;
      leave();
    };
  }, []);

  const value = useMemo(() => ({ hidden, swiped }), [hidden, swiped]);

  return (
    <SwipeDeleteContext.Provider value={value}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {(undoId !== null || notice) && (
          <div className="pointer-events-auto flex flex-col gap-1 rounded-lg bg-foreground px-4 py-2.5 text-sm text-background shadow-lg" data-swipe-toast>
            {notice && <span data-swipe-notice>{t(notice)}</span>}
            {undoId !== null && (
              <div className="flex items-center justify-between gap-4">
                <span>{t("deleted")}</span>
                <button type="button" onClick={undo} className="-my-1 cursor-pointer rounded px-2 py-1 font-semibold underline-offset-2 hover:underline focus-visible:outline-2">
                  {t("undo")}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </SwipeDeleteContext.Provider>
  );
}

/**
 * A search result row. On touch screens it can be swiped left to delete; `swipeable` is false for jobs the
 * bulk delete keeps by default (applying and later) and for jobs whose intake is still running.
 */
export function SwipeRow({ id, swipeable, children }: { id: number; swipeable: boolean; children: ReactNode }) {
  const ctx = useContext(SwipeDeleteContext);
  if (!ctx) throw new Error("SwipeDeleteProvider is missing");
  const { hidden, swiped } = ctx;
  const onSwiped = useCallback(() => swiped(id), [swiped, id]);
  const { trackRef, reveal, reset, handlers } = useSwipeLeft({ enabled: swipeable, onSwiped });
  const isHidden = hidden.has(id);

  // Collapse the row's height after it has slid out, then take it out of the list.
  const [collapsed, setCollapsed] = useState(isHidden);
  if (!isHidden && collapsed) setCollapsed(false);
  const item = useRef<HTMLLIElement>(null);
  useEffect(() => {
    const el = item.current;
    if (!isHidden) {
      // Undo during the slide-out: put the row back where it was.
      el?.removeAttribute("style");
      reset();
      return;
    }
    if (!el) return;
    // The row is told it's hidden as the slide-out starts; collapse once it has slid out.
    const collapse = window.setTimeout(() => {
      el.style.height = `${el.offsetHeight}px`;
      el.style.overflow = "hidden";
      void el.offsetHeight;
      el.style.transition = `height ${SWIPE_ANIMATION_MS}ms ease-out, margin ${SWIPE_ANIMATION_MS}ms ease-out`;
      el.style.height = "0px";
      // Cancels the list's gap so the rows below close up smoothly.
      el.style.marginBottom = "-0.5rem";
    }, SWIPE_ANIMATION_MS);
    const remove = window.setTimeout(() => setCollapsed(true), 2 * SWIPE_ANIMATION_MS);
    return () => {
      window.clearTimeout(collapse);
      window.clearTimeout(remove);
    };
  }, [isHidden, reset]);

  if (isHidden && collapsed) return null;
  return (
    <li ref={item} className="relative" data-swipe-row={id} data-swipeable={swipeable ? "true" : "false"}>
      {swipeable && (
        <div ref={reveal} aria-hidden className="absolute inset-0 flex items-center justify-end rounded-lg bg-danger pr-5 text-white opacity-0">
          <Trash2 className="size-5" />
        </div>
      )}
      <div ref={trackRef} className={swipeable ? "relative touch-pan-y touch-pinch-zoom" : "relative"} data-swipe-track {...handlers}>
        {children}
      </div>
    </li>
  );
}
