"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/form";
import { JOB_STATUSES } from "@/shared/schemas/job";
import { APPLY_CHANNELS, END_STAGES, isOutcomeStatus, type Outcome, type OutcomeStatus } from "@/shared/schemas/pipeline";
import { setJobStatusAction } from "@/app/jobs/[id]/actions";

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Optional details recorded with a move to applied / interviewing / offer / rejected. */
function OutcomeForm({ status, pending, onSave, onCancel }: { status: OutcomeStatus; pending: boolean; onSave: (o: Outcome) => void; onCancel: () => void }) {
  const t = useTranslations("pipeline.outcome");
  const [outcome, setOutcome] = useState<Outcome>({ date: today(), channel: null, round: null, stage: status === "rejected" ? "after_application" : null, note: null });
  const set = (patch: Partial<Outcome>) => setOutcome((o) => ({ ...o, ...patch }));
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-surface p-3 text-sm" data-outcome-form={status}>
      <p className="font-medium">{t(`title.${status}`)}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`outcome-date-${status}`}>{t(`date.${status}`)}</Label>
          <Input id={`outcome-date-${status}`} type="date" value={outcome.date ?? ""} onChange={(e) => set({ date: e.target.value || null })} />
        </div>
        {status === "applied" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="outcome-channel">{t("channel")}</Label>
            <Select id="outcome-channel" value={outcome.channel ?? ""} onChange={(e) => set({ channel: (e.target.value || null) as Outcome["channel"] })}>
              <option value="">{t("notSaying")}</option>
              {APPLY_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {t(`channels.${c}`)}
                </option>
              ))}
            </Select>
          </div>
        )}
        {status === "interviewing" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="outcome-round">{t("round")}</Label>
            <Input id="outcome-round" value={outcome.round ?? ""} placeholder={t("roundPlaceholder")} maxLength={80} onChange={(e) => set({ round: e.target.value || null })} />
          </div>
        )}
        {status === "rejected" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="outcome-stage">{t("stage")}</Label>
            <Select id="outcome-stage" value={outcome.stage ?? ""} onChange={(e) => set({ stage: (e.target.value || null) as Outcome["stage"] })}>
              {END_STAGES.map((s) => (
                <option key={s} value={s}>
                  {t(`stages.${s}`)}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`outcome-note-${status}`}>{t("note")}</Label>
        <Textarea id={`outcome-note-${status}`} rows={2} maxLength={1000} value={outcome.note ?? ""} placeholder={t(`notePlaceholder.${status}`)} onChange={(e) => set({ note: e.target.value || null })} />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={pending} onClick={() => onSave(outcome)}>
          {t("save")}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </div>
  );
}

/** The job's pipeline stage. Moving to applied, interviewing, offer or rejected asks for optional details. */
export function StatusSelect({ jobId, status, compact = false }: { jobId: number; status: string; compact?: boolean }) {
  const t = useTranslations("jobStatus");
  const tJob = useTranslations("job");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [target, setTarget] = useState<OutcomeStatus | null>(null);
  const move = (next: string, outcome?: Outcome) =>
    start(async () => {
      await setJobStatusAction(jobId, next, outcome ?? null);
      setTarget(null);
      router.refresh();
    });
  const id = `status-${jobId}${compact ? "-card" : ""}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Label htmlFor={id} className={compact ? "sr-only" : "text-sm text-muted"}>
          {tJob("statusLabel")}
        </Label>
        <Select
          id={id}
          value={target ?? status}
          disabled={pending}
          className="h-8 w-auto"
          onChange={(e) => {
            const next = e.target.value;
            if (next === status) setTarget(null);
            else if (isOutcomeStatus(next)) setTarget(next);
            else move(next);
          }}
        >
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(s)}
            </option>
          ))}
        </Select>
      </div>
      {target && <OutcomeForm key={target} status={target} pending={pending} onSave={(o) => move(target, o)} onCancel={() => setTarget(null)} />}
    </div>
  );
}
