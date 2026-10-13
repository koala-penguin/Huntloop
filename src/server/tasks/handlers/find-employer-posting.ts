import { z } from "zod";
import { runBrowserAgent } from "../../ai/browser-agent/agent";
import { getJob, updateJob } from "../../repo/jobs";
import { getCompany } from "../../research/company";
import { getSourceSettings } from "../../repo/settings";
import { processJob } from "../../jobs/pipeline";
import { UserFacingError } from "../../errors";
import { registerTaskHandler, type TaskContext } from "../runner";

export const FIND_EMPLOYER_POSTING_TASK = "find-employer-posting";

const payloadSchema = z.object({ jobId: z.number().int() });

/** "https://tidal.example" from a stored company domain (a bare host or a full URL). */
export function employerUrlFrom(domain: string | null | undefined): string | null {
  if (!domain) return null;
  if (/^https?:\/\//i.test(domain)) return domain;
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? `https://${domain}` : null;
}

/**
 * The browsing agent looks for this job on the employer's own site. If found, the job gets the
 * employer's link and full posting text, and is analysed again from it.
 */
export async function runFindEmployerPosting(ctx: TaskContext): Promise<{ found: boolean; url: string | null }> {
  const { jobId } = payloadSchema.parse(ctx.payload);
  const job = getJob(ctx.db, ctx.userId, jobId);
  if (!job) throw new UserFacingError("not_found");
  if (!getSourceSettings(ctx.db, ctx.userId).agent.enabled) throw new UserFacingError("agent_disabled");
  if (!job.companyName || !job.title) throw new UserFacingError("no_company");
  const company = job.companyId ? getCompany(ctx.db, ctx.userId, job.companyId) : undefined;
  const notes: string[] = [];
  ctx.progress({ stage: "browsing", notes });

  const result = await runBrowserAgent(
    { db: ctx.db, userId: ctx.userId, signal: ctx.signal },
    { kind: "find_on_employer_site", job: { title: job.title, company: job.companyName, location: job.locationText }, employerUrl: employerUrlFrom(company?.domain) },
    {
      signal: ctx.signal,
      waitForUser: ctx.waitForUser,
      maxSteps: 20,
      onProgress: (note) => {
        if (notes.at(-1) === note) return;
        notes.push(note);
        ctx.progress({ stage: "browsing", notes: notes.slice(-6) });
      },
    },
  );
  const lead = result.leads[0];
  if (!lead) return { found: false, url: null };

  ctx.progress({ stage: "analyzing", notes: notes.slice(-6) });
  const updated = updateJob(ctx.db, job.id, {
    applyUrl: lead.url,
    rawText: lead.text,
    intake: { ...(job.intake ?? {}), noisy: true, partial: false, hints: { ...(job.intake?.hints ?? {}), applyUrl: lead.url } },
  });
  await processJob({ db: ctx.db, userId: ctx.userId, signal: ctx.signal }, updated, { waitForUser: ctx.waitForUser });
  return { found: true, url: lead.url };
}

registerTaskHandler(FIND_EMPLOYER_POSTING_TASK, { run: runFindEmployerPosting, maxAttempts: 1 });
