"use client";

import { useEffect, useState } from "react";

export interface TaskState {
  id: number;
  kind: string;
  status: "queued" | "running" | "needs_user_action" | "succeeded" | "failed" | "cancelled";
  progress: unknown;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
}

const FINAL = new Set(["succeeded", "failed", "cancelled"]);

/** Polls a background task until it finishes. Pass null to stay idle. */
export function useTask(taskId: number | null, intervalMs = 1000): TaskState | null {
  const [state, setState] = useState<TaskState | null>(null);

  useEffect(() => {
    if (taskId === null) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as TaskState;
          if (stopped) return;
          setState(next);
          if (FINAL.has(next.status)) return;
        }
      } catch {
        // Network hiccup: keep polling.
      }
      if (!stopped) timer = setTimeout(poll, intervalMs);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId, intervalMs]);

  return taskId === null ? null : state;
}
