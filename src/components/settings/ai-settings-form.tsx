"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AI_TASKS, type AiSettings, type AiTask } from "@/shared/ai-settings";
import { EFFORT_LEVELS, MODEL_IDS, MODELS, isModelId, type Effort, type ModelId } from "@/shared/models";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label, Select } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { saveAiSettingsAction, checkModelAccessAction, type ModelAccessResult } from "@/app/settings/actions";

interface Props {
  initial: AiSettings;
  /** Pre-formatted on the server (Intl output can differ between Node and the browser). */
  spentToday: string;
  spentMonth: string;
}

type Status = { kind: "idle" } | { kind: "saved" } | { kind: "error"; message: string };

export function AiSettingsForm({ initial, spentToday, spentMonth }: Props) {
  const t = useTranslations("settings");
  const tTasks = useTranslations("aiTasks");
  const tEffort = useTranslations("effort");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [settings, setSettings] = useState<AiSettings>(initial);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [pending, startTransition] = useTransition();
  const [access, setAccess] = useState<ModelAccessResult | null>(null);
  const [checking, startChecking] = useTransition();

  const update = (fn: (s: AiSettings) => AiSettings) => {
    setSettings(fn);
    setStatus({ kind: "idle" });
  };

  const setTask = (task: AiTask, patch: Partial<{ model: ModelId | null; effort: Effort }>) =>
    update((s) => ({ ...s, tasks: { ...s.tasks, [task]: { ...s.tasks[task], ...patch } } }));

  const save = () =>
    startTransition(async () => {
      const result = await saveAiSettingsAction(settings);
      if (result.ok) {
        setSettings(result.settings);
        setStatus({ kind: "saved" });
        router.refresh();
      } else {
        setStatus({ kind: "error", message: result.error });
      }
    });

  const saveBar = (
    <div className="mt-5 flex items-center gap-3">
      <Button type="button" onClick={save} disabled={pending}>
        {pending ? tCommon("saving") : tCommon("save")}
      </Button>
      {status.kind === "saved" && <span className="text-sm text-accent">{tCommon("saved")}</span>}
      {status.kind === "error" && <span className="text-sm text-danger">{t("saveError", { message: status.message })}</span>}
    </div>
  );

  const defaultLabel = MODELS[settings.defaultModel].label;

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("modelsTitle")}</CardTitle>
          <CardDescription>{t("modelsDescription")}</CardDescription>
        </CardHeader>

        <div className="flex flex-col gap-2 sm:max-w-sm">
          <Label htmlFor="default-model">{t("defaultModel")}</Label>
          <Select
            id="default-model"
            value={settings.defaultModel}
            onChange={(e) => isModelId(e.target.value) && update((s) => ({ ...s, defaultModel: e.target.value as ModelId }))}
          >
            {MODEL_IDS.map((id) => (
              <option key={id} value={id}>
                {MODELS[id].label}
              </option>
            ))}
          </Select>
          <FieldHint>
            {t("pricePerMillion", {
              input: MODELS[settings.defaultModel].pricing.input,
              output: MODELS[settings.defaultModel].pricing.output,
            })}
          </FieldHint>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="button" variant="secondary" size="sm" disabled={checking} onClick={() => startChecking(async () => setAccess(await checkModelAccessAction()))}>
            {checking ? t("checking") : t("checkAccess")}
          </Button>
          {access?.ok === false && <span className="text-sm text-danger">{t("accessError", { message: access.error })}</span>}
          {access?.ok && access.mode === "fake" && <span className="text-sm text-muted">{t("accessDemo")}</span>}
        </div>
        {access?.ok && (
          <ul className="mt-3 flex flex-wrap gap-2">
            {MODEL_IDS.map((id) => {
              const available = access.available.includes(id);
              return (
                <li key={id}>
                  <Badge tone={available ? "neutral" : "danger"}>
                    {MODELS[id].label}
                    {": "}
                    {available ? t("accessAvailable") : t("accessUnavailable")}
                  </Badge>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="py-2 pr-4 font-medium">{t("task")}</th>
                <th className="py-2 pr-4 font-medium">{t("model")}</th>
                <th className="py-2 font-medium">{t("effort")}</th>
              </tr>
            </thead>
            <tbody>
              {AI_TASKS.map((task) => {
                const entry = settings.tasks[task];
                return (
                  <tr key={task} className="border-b border-border last:border-0">
                    <td className="py-3 pr-4 align-top">
                      <p className="font-medium">{tTasks(`${task}.name`)}</p>
                      <p className="text-xs text-muted">{tTasks(`${task}.description`)}</p>
                    </td>
                    <td className="py-3 pr-4 align-top">
                      <Select
                        aria-label={`${tTasks(`${task}.name`)} — ${t("model")}`}
                        value={entry.model ?? ""}
                        onChange={(e) => setTask(task, { model: isModelId(e.target.value) ? e.target.value : null })}
                      >
                        <option value="">{t("useDefault", { model: defaultLabel })}</option>
                        {MODEL_IDS.map((id) => (
                          <option key={id} value={id}>
                            {MODELS[id].label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="py-3 align-top">
                      <Select
                        aria-label={`${tTasks(`${task}.name`)} — ${t("effort")}`}
                        value={entry.effort}
                        onChange={(e) => setTask(task, { effort: e.target.value as Effort })}
                      >
                        {EFFORT_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {tEffort(level)}
                          </option>
                        ))}
                      </Select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {saveBar}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("budgetTitle")}</CardTitle>
          <CardDescription>{t("budgetDescription")}</CardDescription>
        </CardHeader>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="daily-cap">{t("dailyCap")}</Label>
            <Input
              id="daily-cap"
              type="number"
              min={0}
              step={0.5}
              value={settings.budget.dailyUsd}
              onChange={(e) => update((s) => ({ ...s, budget: { ...s.budget, dailyUsd: Number(e.target.value) || 0 } }))}
            />
            <FieldHint>{t("spentToday", { amount: spentToday })}</FieldHint>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="monthly-cap">{t("monthlyCap")}</Label>
            <Input
              id="monthly-cap"
              type="number"
              min={0}
              step={1}
              value={settings.budget.monthlyUsd ?? ""}
              onChange={(e) =>
                update((s) => ({ ...s, budget: { ...s.budget, monthlyUsd: e.target.value === "" ? null : Number(e.target.value) } }))
              }
            />
            <FieldHint>
              {t("monthlyCapHint")} {t("spentMonth", { amount: spentMonth })}
            </FieldHint>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="warn-at">{t("warnAt")}</Label>
            <Input
              id="warn-at"
              type="number"
              min={1}
              max={100}
              value={settings.budget.warnAtPercent}
              onChange={(e) =>
                update((s) => ({ ...s, budget: { ...s.budget, warnAtPercent: Math.min(100, Math.max(1, Number(e.target.value) || 80)) } }))
              }
            />
          </div>
        </div>
        {saveBar}
      </Card>
    </>
  );
}
