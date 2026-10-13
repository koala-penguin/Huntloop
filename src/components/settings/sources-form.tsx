"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AlertTriangle, Bot, Check, Loader2, MonitorPlay, Plus, X } from "lucide-react";
import type { BrowserSite, SourceSettings } from "@/shared/source-settings";
import { Button } from "@/components/ui/button";
import { Alert, Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, Input, Label } from "@/components/ui/form";
import { saveSourceSettingsAction, testBrowserAction } from "@/app/settings/actions";

/** Settings → Sources: which job sources searches use; SEEK and LinkedIn are opt-in with a risk notice. */
export function SourcesForm({ initial, adzunaConfigured, today }: { initial: SourceSettings; adzunaConfigured: boolean; today: string }) {
  const t = useTranslations("settings.sources");
  const tCommon = useTranslations("common");
  const router = useRouter();
  const [settings, setSettings] = useState(initial);
  const [confirming, setConfirming] = useState<BrowserSite | "agent" | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browserCheck, setBrowserCheck] = useState<"ok" | "failed" | null>(null);
  const [pending, start] = useTransition();
  const [testing, startTest] = useTransition();

  const save = (next: SourceSettings) => {
    setSettings(next);
    setSaved(false);
    start(async () => {
      const result = await saveSourceSettingsAction(next);
      if (!result.ok) setError(result.error);
      else {
        setSettings(result.settings);
        setSaved(true);
        router.refresh();
      }
    });
  };

  const toggle = (site: BrowserSite, on: boolean) => {
    if (on && !settings[site].acceptedRiskAt) return setConfirming(site);
    save({ ...settings, [site]: { ...settings[site], enabled: on } });
  };

  const siteCard = (site: BrowserSite) => {
    const s = settings[site];
    return (
      <div key={site} className="flex flex-col gap-3 rounded-md border border-border p-4" data-site={site}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col">
            <span className="font-medium">{t(`${site}.name`)}</span>
            <span className="text-xs text-muted">{t(`${site}.description`)}</span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={s.enabled} disabled={pending} onChange={(e) => toggle(site, e.target.checked)} aria-label={t("useSite", { site: t(`${site}.name`) })} />
            {s.enabled ? t("on") : t("off")}
          </label>
        </div>
        {confirming === site && (
          <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning" role="alertdialog" aria-label={t("riskTitle")}>
            <p className="flex items-center gap-2 font-medium">
              <AlertTriangle className="size-4" aria-hidden />
              {t("riskTitle")}
            </p>
            <p>{t(`${site}.risk`)}</p>
            <ul className="list-disc pl-5">
              <li>{t("riskPacing")}</li>
              <li>{t("riskVisible")}</li>
              <li>{t("riskNoEvasion")}</li>
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setConfirming(null);
                  save({ ...settings, [site]: { ...s, enabled: true, acceptedRiskAt: today } });
                }}
              >
                <Check className="size-3.5" aria-hidden />
                {t("acceptAndTurnOn")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>
                {tCommon("cancel")}
              </Button>
            </div>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${site}-pages`}>{t("maxPages")}</Label>
            <Input
              id={`${site}-pages`}
              type="number"
              min={1}
              max={50}
              value={s.maxPages}
              onChange={(e) => setSettings({ ...settings, [site]: { ...s, maxPages: Math.min(50, Math.max(1, Math.round(Number(e.target.value) || 1))) } })}
              onBlur={() => save(settings)}
            />
            <FieldHint>{t("maxPagesHint")}</FieldHint>
          </div>
          {site === "linkedin" && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={settings.linkedin.useLogin}
                disabled={pending}
                onChange={(e) => save({ ...settings, linkedin: { ...settings.linkedin, useLogin: e.target.checked } })}
              />
              <span className="flex flex-col">
                <span>{t("linkedin.useLogin")}</span>
                <span className="text-xs text-muted">{t("linkedin.useLoginHint")}</span>
              </span>
            </label>
          )}
        </div>
      </div>
    );
  };


  const agent = settings.agent;
  const setAgent = (patch: Partial<SourceSettings["agent"]>) => setSettings({ ...settings, agent: { ...agent, ...patch } });
  const validSites = (list: SourceSettings["agent"]["sites"]) =>
    list.filter((x) => {
      try {
        return x.name.trim() && /^https?:$/.test(new URL(x.url).protocol);
      } catch {
        return false;
      }
    });
  const agentCard = (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4" data-site="agent">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="flex items-center gap-2 font-medium">
            <Bot className="size-4" aria-hidden />
            {t("agent.name")}
          </span>
          <span className="text-xs text-muted">{t("agent.description")}</span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={agent.enabled}
            disabled={pending}
            aria-label={t("agent.toggle")}
            onChange={(e) => (e.target.checked ? setConfirming("agent") : save({ ...settings, agent: { ...agent, enabled: false } }))}
          />
          {agent.enabled ? t("on") : t("off")}
        </label>
      </div>
      {confirming === "agent" && (
        <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-warning" role="alertdialog" aria-label={t("agent.noticeTitle")}>
          <p className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" aria-hidden />
            {t("agent.noticeTitle")}
          </p>
          <ul className="list-disc pl-5">
            <li>{t("agent.noticeCost")}</li>
            <li>{t("agent.noticeGuard")}</li>
            <li>{t("agent.noticeTerms")}</li>
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setConfirming(null);
                save({ ...settings, agent: { ...agent, enabled: true } });
              }}
            >
              <Check className="size-3.5" aria-hidden />
              {t("agent.turnOn")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(null)}>
              {tCommon("cancel")}
            </Button>
          </div>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={agent.fallback} disabled={pending} onChange={(e) => save({ ...settings, agent: { ...agent, fallback: e.target.checked } })} />
        <span className="flex flex-col">
          <span>{t("agent.fallback")}</span>
          <span className="text-xs text-muted">{t("agent.fallbackHint")}</span>
        </span>
      </label>
      <div className="flex max-w-xs flex-col gap-1.5">
        <Label htmlFor="agent-max-jobs">{t("agent.maxJobs")}</Label>
        <Input
          id="agent-max-jobs"
          type="number"
          min={1}
          max={20}
          value={agent.maxJobs}
          onChange={(e) => setAgent({ maxJobs: Math.min(20, Math.max(1, Math.round(Number(e.target.value) || 1))) })}
          onBlur={() => save(settings)}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t("agent.sites")}</legend>
        <p className="text-xs text-muted">{t("agent.sitesHint")}</p>
        {agent.sites.map((site, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Input aria-label={t("agent.siteName")} placeholder={t("agent.siteNamePlaceholder")} value={site.name} className="w-48" onChange={(e) => setAgent({ sites: agent.sites.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <Input aria-label={t("agent.siteUrl")} placeholder="https://" value={site.url} className="min-w-0 flex-1" onChange={(e) => setAgent({ sites: agent.sites.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
            <Button type="button" variant="ghost" size="sm" aria-label={t("agent.removeSite", { site: site.name || site.url })} onClick={() => save({ ...settings, agent: { ...agent, sites: validSites(agent.sites.filter((_, j) => j !== i)) } })}>
              <X className="size-3.5" aria-hidden />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={agent.sites.length >= 10} onClick={() => setAgent({ sites: [...agent.sites, { name: "", url: "" }] })}>
            <Plus className="size-3.5" aria-hidden />
            {t("agent.addSite")}
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => save({ ...settings, agent: { ...agent, sites: validSites(agent.sites) } })}>
            {t("agent.saveSites")}
          </Button>
        </div>
      </fieldset>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <div className="flex flex-col gap-4">
        <ul className="flex flex-col gap-2 text-sm">
          <li className="flex items-center justify-between gap-3">
            <span>{t("webAgent")}</span>
            <Badge tone="neutral">{t("on")}</Badge>
          </li>
          <li className="flex items-center justify-between gap-3">
            <span>{t("adzuna")}</span>
            <Badge tone={adzunaConfigured ? "neutral" : "outline"}>{adzunaConfigured ? t("on") : t("adzunaNeedsKeys")}</Badge>
          </li>
        </ul>
        {siteCard("seek")}
        {siteCard("linkedin")}
        {agentCard}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={testing}
            onClick={() =>
              startTest(async () => {
                const result = await testBrowserAction();
                setBrowserCheck(result.ok ? "ok" : "failed");
              })
            }
          >
            {testing ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <MonitorPlay className="size-3.5" aria-hidden />}
            {t("testBrowser")}
          </Button>
          {browserCheck === "ok" && <span className="text-sm text-muted">{t("browserOk")}</span>}
          {saved && !pending && <span className="text-sm text-muted">{t("saved")}</span>}
        </div>
        {browserCheck === "failed" && <Alert tone="danger">{t("browserFailed")}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Card>
  );
}
