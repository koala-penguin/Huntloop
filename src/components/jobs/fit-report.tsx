import { getTranslations } from "next-intl/server";
import { AlertTriangle, CheckCircle2, CircleHelp, XCircle } from "lucide-react";
import type { Assessment, AssessmentItem, GateResult, PostingAnalysis, Requirement, ScoreResult, ScoredItem } from "@/shared/schemas/job";
import { marketPack } from "@/shared/markets";
import { countryName } from "@/shared/countries";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { TierBadge } from "./tier-badge";
import { AnswerButtons, WorkRightsQuestion } from "./job-controls";

interface Props {
  jobId: number;
  locale: string;
  analysis: PostingAnalysis;
  assessment: Assessment;
  score: ScoreResult;
  answers: Record<string, "yes" | "no">;
}

const GATE_ICON = { pass: CheckCircle2, fail: XCircle, unclear: CircleHelp } as const;
const GATE_TONE = { pass: "text-tier-strong", fail: "text-danger", unclear: "text-warning" } as const;
const STATUS_TONE = { met: "accent", partial: "neutral", unknown: "warning", unmet: "danger" } as const;

function Quote({ children, className }: { children: string; className?: string }) {
  return <q className={cn("text-sm italic before:content-['“'] after:content-['”']", className)}>{children}</q>;
}

export async function FitReport({ jobId, locale, analysis, assessment, score, answers }: Props) {
  const t = await getTranslations("fit");
  const tWork = await getTranslations("markets.workRights");
  const country = (code: string | number | undefined) => (typeof code === "string" && code ? countryName(code, locale) : t("unknownCountry"));
  const reqs = new Map(analysis.requirements.map((r) => [r.id, r]));
  const items = new Map(assessment.items.map((i) => [i.requirementId, i]));
  const scored = new Map(score.items.map((i) => [i.requirementId, i]));

  const gateText = (g: GateResult) => t(`gateReason.${g.reasonKey}`, { country: country(g.params?.country), days: Number(g.params?.days ?? 0) });

  const assessed = analysis.requirements.filter((r) => items.has(r.id));
  const musts = assessed.filter((r) => r.kind !== "nice");
  const nices = assessed.filter((r) => r.kind === "nice");
  const gaps = (type: AssessmentItem["gapType"]) =>
    assessed.filter((r) => {
      const s = scored.get(r.id);
      return s && s.status !== "met" && items.get(r.id)?.gapType === type;
    });
  const gapBuckets = (["not_on_cv", "transferable", "real_gap"] as const).map((type) => ({ type, list: gaps(type) })).filter((b) => b.list.length);

  const workRightGate = score.gates.find((g) => g.reasonKey === "work_rights_unknown" && typeof g.params?.country === "string");

  return (
    <div className="flex flex-col gap-4">
      {/* Verdict */}
      <Card>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{t("interviewChance")}</span>
            <TierBadge tier={score.tier} label={t(`tier.${score.tier}`)} large />
            <Badge tone={score.eligibility === "eligible" ? "accent" : score.eligibility === "verify" ? "warning" : "danger"}>{t(`eligibility.${score.eligibility}`)}</Badge>
            <Badge tone="outline">{t(`confidence.${score.confidence}`)}</Badge>
          </div>
          <p className="text-base">{assessment.oneLine}</p>
          <p className="text-xs text-muted">{t("tierExplainer")}</p>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">{t("howScored")}</summary>
            <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-3">
              {(Object.keys(score.components) as Array<keyof ScoreResult["components"]>).map((key) => (
                <div key={key} className="flex justify-between gap-2">
                  <dt className="text-muted">{t(`component.${key}`)}</dt>
                  <dd className="tabular-nums">{Math.round(score.components[key] * 100)}</dd>
                </div>
              ))}
            </dl>
            {score.adjustments.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-2">
                {score.adjustments.map((a) => (
                  <li key={a.kind}>
                    <Badge tone="outline">{t(`adjustment.${a.kind}`, { points: a.points > 0 ? `+${a.points}` : String(a.points) })}</Badge>
                  </li>
                ))}
              </ul>
            )}
            {score.capsApplied.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-muted">
                {score.capsApplied.map((c) => (
                  <li key={c.reasonKey}>{t(`cap.${c.reasonKey}`, { tier: t(`tier.${c.maxTier}`) })}</li>
                ))}
              </ul>
            )}
          </details>
        </div>
      </Card>

      {/* Eligibility gates */}
      <Card>
        <CardHeader>
          <CardTitle>{t("gatesTitle")}</CardTitle>
          <CardDescription>{t("gatesDescription")}</CardDescription>
        </CardHeader>
        <ul className="flex flex-col gap-3">
          {score.gates.map((g, i) => {
            const Icon = GATE_ICON[g.status];
            return (
              <li key={`${g.kind}-${i}`} className="flex gap-3" data-gate={g.kind} data-status={g.status}>
                <Icon className={cn("mt-0.5 size-5 shrink-0", GATE_TONE[g.status])} aria-hidden />
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-sm">
                    <span className="font-medium">{t(`gateKind.${g.kind}`)}</span>
                    <span className="sr-only">{` — ${t(`gateStatus.${g.status}`)}`}</span>
                    {" · "}
                    {gateText(g)}
                  </p>
                  {g.postingQuote && <Quote className="text-muted">{g.postingQuote}</Quote>}
                  {g.requirementId && items.get(g.requirementId)?.postingQuoteGloss && <p className="text-xs text-muted">{items.get(g.requirementId)!.postingQuoteGloss}</p>}
                </div>
              </li>
            );
          })}
        </ul>
        {workRightGate && (
          <div className="mt-4">
            <WorkRightsQuestion
              country={String(workRightGate.params!.country)}
              countryLabel={country(workRightGate.params!.country)}
              options={[
                ...marketPack(String(workRightGate.params!.country)).workRightOptions.map((o) => ({ id: o.id, label: tWork(o.id) })),
              ]}
            />
          </div>
        )}
      </Card>

      {/* Requirements */}
      <Card>
        <CardHeader>
          <CardTitle>{t("requirementsTitle")}</CardTitle>
          <CardDescription>{t("requirementsDescription", { count: analysis.requirements.length })}</CardDescription>
        </CardHeader>
        {[
          { key: "must", list: musts },
          { key: "nice", list: nices },
        ]
          .filter((g) => g.list.length)
          .map((group) => (
            <section key={group.key} className="mb-4 flex flex-col gap-2 last:mb-0">
              <h3 className="text-sm font-semibold">{t(`group.${group.key}`)}</h3>
              <ul className="flex flex-col divide-y divide-border">
                {group.list.map((req) => (
                  <RequirementRow key={req.id} jobId={jobId} req={req} item={items.get(req.id)!} scored={scored.get(req.id)} answer={answers[req.id] ?? null} t={t} />
                ))}
              </ul>
            </section>
          ))}
        {analysis.droppedRequirements > 0 && <p className="mt-2 text-xs text-muted">{t("droppedRequirements", { count: analysis.droppedRequirements })}</p>}
      </Card>

      {/* Strengths & gaps */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("strengthsTitle")}</CardTitle>
          </CardHeader>
          {assessment.strengths.length ? (
            <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
              {assessment.strengths.map((s, i) => (
                <li key={i}>{s.text}</li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t("none")}</p>
          )}
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("gapsTitle")}</CardTitle>
          </CardHeader>
          {gapBuckets.length ? (
            <div className="flex flex-col gap-3">
              {gapBuckets.map((bucket) => (
                <section key={bucket.type} className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium">{t(`gap.${bucket.type}`)}</h3>
                  <p className="text-xs text-muted">{t(`gapHint.${bucket.type}`)}</p>
                  <ul className="flex flex-wrap gap-1.5">
                    {bucket.list.map((r) => (
                      <li key={r.id}>
                        <Badge tone="outline">{r.normalized}</Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">{t("noGaps")}</p>
          )}
        </Card>
      </div>

      {score.whatWouldChange.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t("changeTitle")}</CardTitle>
            <CardDescription>{t("changeDescription")}</CardDescription>
          </CardHeader>
          <ul className="flex flex-col gap-2 text-sm">
            {score.whatWouldChange.map((c) => (
              <li key={c.requirementId} className="flex flex-wrap items-center gap-2">
                <span>{t("changeItem", { requirement: reqs.get(c.requirementId)?.normalized ?? c.requirementId })}</span>
                <TierBadge tier={c.newTier} label={t(`tier.${c.newTier}`)} />
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("boostersTitle")}</CardTitle>
          </CardHeader>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
            {assessment.boosters.map((b, i) => (
              <li key={i}>{b.text}</li>
            ))}
          </ul>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("risksTitle")}</CardTitle>
          </CardHeader>
          {assessment.risks.length || analysis.ghostSignals.length ? (
            <ul className="flex flex-col gap-2 text-sm">
              {assessment.risks.map((r, i) => (
                <li key={i} className="flex gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  {r.text}
                </li>
              ))}
              {analysis.ghostSignals.map((g, i) => (
                <li key={`ghost-${i}`} className="flex gap-2">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
                  <span>
                    <span className="font-medium">{t("ghostSignal")}</span> {g}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t("none")}</p>
          )}
        </Card>
      </div>
    </div>
  );
}

type T = Awaited<ReturnType<typeof getTranslations<"fit">>>;

function RequirementRow({
  jobId,
  req,
  item,
  scored,
  answer,
  t,
}: {
  jobId: number;
  req: Requirement;
  item: AssessmentItem;
  scored: ScoredItem | undefined;
  answer: "yes" | "no" | null;
  t: T;
}) {
  const status = scored?.status ?? "unknown";
  const evidence = scored?.verifiedEvidence ?? [];
  const askable = !!item.question && (answer !== null || status === "unknown" || item.gapType === "not_on_cv");
  return (
    <li className="flex flex-col gap-2 py-3" data-requirement={req.id} data-status={status}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <Quote>{req.postingQuote}</Quote>
          {item.postingQuoteGloss && <p className="text-xs text-muted">{item.postingQuoteGloss}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {req.kind === "gate" && <Badge tone="outline">{t("kind.gate")}</Badge>}
          <Badge tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Badge>
        </div>
      </div>
      <p className="text-sm text-muted">{item.reasoning}</p>
      {evidence.length > 0 && (
        <ul className="flex flex-col gap-1 border-l-2 border-accent pl-3">
          {evidence.map((e, i) => (
            <li key={i} className="text-sm">
              <span className="mr-1 text-xs text-muted">{e.source === "cv" ? t("evidenceCv") : t("evidenceFact")}</span>
              <Quote>{e.quote}</Quote>
            </li>
          ))}
        </ul>
      )}
      {scored && scored.droppedEvidence > 0 && <p className="text-xs text-muted">{t("droppedEvidence", { count: scored.droppedEvidence })}</p>}
      {askable && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-accent-soft px-3 py-2">
          <span className="text-sm">{item.question}</span>
          <AnswerButtons jobId={jobId} requirementId={req.id} answer={answer} />
        </div>
      )}
    </li>
  );
}
