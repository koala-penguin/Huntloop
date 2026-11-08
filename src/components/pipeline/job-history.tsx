import { getTranslations } from "next-intl/server";
import type { HistoryEntry } from "@/server/pipeline/outcomes";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { JOB_SOURCES, JOB_STATUSES, type JobSource, type JobStatus } from "@/shared/schemas/job";
import { APPLY_CHANNELS, END_STAGES } from "@/shared/schemas/pipeline";

const isStatus = (s: string | null): s is JobStatus => !!s && (JOB_STATUSES as readonly string[]).includes(s);

/** Everything that happened to a job, oldest first, plus the notes saved on it. */
export async function JobHistory({ entries, notes, requirementQuotes, locale }: { entries: HistoryEntry[]; notes: string | null; requirementQuotes: Record<string, string>; locale: string }) {
  const t = await getTranslations("pipeline.history");
  const tOutcome = await getTranslations("pipeline.outcome");
  const tStatus = await getTranslations("jobStatus");
  const tEnum = await getTranslations("jobEnums");
  const when = (d: Date) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);

  const describe = (e: HistoryEntry): string | null => {
    if (e.type === "created") return t("created", { source: (JOB_SOURCES as readonly string[]).includes(e.to ?? "") ? tEnum(`source.${e.to as JobSource}`) : (e.to ?? "") });
    if (e.type === "status" && isStatus(e.to)) return t("status", { from: isStatus(e.from) ? tStatus(e.from) : "—", to: tStatus(e.to) });
    if (e.type === "answer") {
      const requirement = requirementQuotes[e.from ?? ""] ?? e.from ?? "";
      return e.to === "cleared" ? t("answerCleared", { requirement }) : t("answer", { requirement, answer: t(e.to === "yes" ? "yes" : "no") });
    }
    if (e.type === "cv_exported") return t("cvExported", { format: (e.to ?? "").toUpperCase(), version: e.note ?? "" });
    return null;
  };

  const details = (e: HistoryEntry): string[] => {
    const o = e.data?.outcome;
    const out: string[] = [];
    if (o?.date) out.push(tOutcome(`date.${e.to as "applied"}`) + `: ${o.date}`);
    if (o?.channel && (APPLY_CHANNELS as readonly string[]).includes(o.channel)) out.push(tOutcome(`channels.${o.channel}`));
    if (o?.round) out.push(o.round);
    if (o?.stage && (END_STAGES as readonly string[]).includes(o.stage)) out.push(tOutcome(`stages.${o.stage}`));
    if (o?.note) out.push(o.note);
    if (e.type === "status" && e.note) out.push(e.note);
    return out;
  };

  const rows = entries.map((e) => ({ e, text: describe(e) })).filter((r) => r.text);
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <ol className="flex flex-col gap-3 border-l-2 border-border pl-4">
          {rows.map(({ e, text }) => (
            <li key={e.id} className="flex flex-col gap-0.5 text-sm" data-history={e.type}>
              <span className="text-xs text-muted">{when(e.at)}</span>
              <span>{text}</span>
              {details(e).map((d, i) => (
                <span key={i} className="text-xs text-muted">
                  {d}
                </span>
              ))}
            </li>
          ))}
        </ol>
      </Card>
      {notes && (
        <Card>
          <CardHeader>
            <CardTitle>{t("notesTitle")}</CardTitle>
            <CardDescription>{t("notesDescription")}</CardDescription>
          </CardHeader>
          <p className="text-sm whitespace-pre-line">{notes}</p>
        </Card>
      )}
    </div>
  );
}
