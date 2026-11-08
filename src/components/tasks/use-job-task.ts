"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { JobTaskKind, JobTaskRefs, TaskRef } from "@/shared/job-tasks";

type Router = ReturnType<typeof useRouter>;

// The controls on one job page mount together: they share the request in flight, and one refresh.
const inFlight = new Map<number, { at: number; refs: Promise<JobTaskRefs | null> }>();
function currentRefs(jobId: number, notBefore = 0): Promise<JobTaskRefs | null> {
  const now = Date.now();
  const hit = inFlight.get(jobId);
  if (hit && hit.at >= notBefore) return hit.refs;
  const refs = fetch(`/api/jobs/${jobId}/tasks`, { cache: "no-store" })
    .then((res) => (res.ok ? (res.json() as Promise<JobTaskRefs>) : null))
    .catch(() => null) // Offline or the server restarting: keep what the page shows.
    .finally(() => {
      if (inFlight.get(jobId)?.refs === refs) inFlight.delete(jobId);
    });
  inFlight.set(jobId, { at: now, refs });
  return refs;
}
// The task each control followed in this browser tab, so coming back to it (even to a freshly
// loaded page) still says why it failed or was cancelled. A new tab or a reload starts clean.
const followed = new Map<string, number>();

let refreshQueued = false;
function refreshOnce(router: Router) {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(() => {
    refreshQueued = false;
    router.refresh();
  }, 0);
}

/**
 * The task a job-page control follows, starting from what the page was rendered with (`known`).
 * On mount, and when the browser restores the page from its back/forward cache, it asks the server
 * again: a page restored from history can predate a task started from it. If a newer task exists than
 * the page knew about, the page refreshes and the control follows that task: its progress, its result,
 * or why it failed or was cancelled (with the control's button to try again). Only tasks newer than the
 * page are followed, so an old failure never comes back. Otherwise a task still running is picked up.
 * A task this tab followed that has since failed or been cancelled stays followed when the page
 * comes back, however the page was loaded (its error, with the button to try again).
 * `showLast`: for controls whose outcome lives only in the task (not in the page's data): start from
 * the newest task even when it has finished, so its outcome shows on every visit.
 */
export function useJobTask(
  jobId: number,
  kind: JobTaskKind,
  known: TaskRef,
  options: { showLast?: boolean } = {},
): [number | null, (taskId: number | null) => void] {
  const router = useRouter();
  const key = `${jobId}:${kind}`;
  const stoppedHere = known.latest !== null && followed.get(key) === known.latest && (known.latestStatus === "failed" || known.latestStatus === "cancelled");
  const [taskId, setTaskId] = useState<number | null>(known.active ?? (options.showLast || stoppedHere ? known.latest : null));
  const knownLatest = known.latest;
  // "Newer than the page" means newer than what this control first rendered with: the page can refresh
  // (and `known` catch up) while the control's first check is still out, and that check is then
  // dropped, so comparing with the refreshed `known` would miss the task it was about to follow.
  const [mountedWith] = useState(known.latest);

  useEffect(() => {
    if (taskId !== null) followed.set(key, taskId);
  }, [key, taskId]);

  useEffect(() => {
    let cancelled = false;
    const check = async (notBefore?: number) => {
      const now = (await currentRefs(jobId, notBefore))?.[kind];
      if (cancelled || !now) return;
      const newer = now.latest;
      if (newer !== knownLatest) refreshOnce(router);
      if (newer !== null && newer !== mountedWith) {
        setTaskId((current) => (current === null || current < newer ? newer : current));
      } else if (now.active !== null) {
        const active = now.active;
        setTaskId((current) => current ?? active);
      }
    };
    void check();
    const onPageShow = (event: PageTransitionEvent) => {
      // Asked again after the restore: a request started since (by another control of the page, as
      // they all hear this event within a few ms) is shared, an older one is not.
      if (event.persisted) void check(Date.now() - 100);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => {
      cancelled = true;
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [jobId, kind, knownLatest, mountedWith, router]);

  return [taskId, setTaskId];
}
