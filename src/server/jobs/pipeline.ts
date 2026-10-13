import type { AiContext } from "../ai/client";
import type { JobRow, JobIntake } from "../db/schema";
import { errorCodeOf, UserFacingError } from "../errors";
import { TaskCancelledError, type TaskContext } from "../tasks/runner";
import { browserSiteFor, readJobInBrowser } from "../sources/browser";
import { sha256 } from "../hash";
import { canonicalizeUrl, domainPolicy } from "../ingest/domain-policy";
import { extractFromHtml, type PostingHints } from "../ingest/html";
import { prepareScreenshot, type PreparedImage } from "../ingest/images";
import { FetchBlockedError, safeFetch } from "../ingest/safe-fetch";
import { detectAtsUrl, fetchAtsPosting, type JsonFetcher } from "../sources/ats";
import { extractDocumentText } from "../cv/extract-text";
import { readUpload } from "../storage";
import { transcribePosting } from "../ai/tasks/transcribe-posting";
import { analyzePosting, getStoredAnalysis } from "../ai/tasks/analyze-posting";
import { assessJob } from "../ai/tasks/assess";
import { getCurrentProfile } from "../repo/profile";
import { getLocalUser, userLocale } from "../repo/users";
import { dedupeKeyFor, listAttachments, updateJob, upsertCompany } from "../repo/jobs";
import { rescoreJob } from "./fit";

export type JobStage = "reading" | "transcribing" | "analyzing" | "assessing" | "scoring" | "done";

export interface ProcessJobOptions {
  /** Run screenshot/PDF transcription (new attachments). Otherwise the stored text is reused. */
  transcribe?: boolean;
  /** Skip reading and analysis; only (re-)assess and score. */
  assessOnly?: boolean;
  /** Search screening: the cheaper screening model/effort, stored as a "screen" assessment. */
  screen?: boolean;
  /** Read the posting from its link first (to replace a snippet with the full posting). */
  preferUrl?: boolean;
  /** From the task runner: pause for the user when the browser hits a CAPTCHA or sign-in. */
  waitForUser?: TaskContext["waitForUser"];
  onStage?: (stage: JobStage) => void;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  fetchJson?: JsonFetcher;
}

export type Content =
  | {
      kind: "content";
      text: string;
      hints: PostingHints;
      noisy: boolean;
      source?: JobRow["source"];
      ats?: { type: string; board: string };
      illegible?: string[];
      /** Only a snippet of the posting. */
      partial?: boolean;
    }
  | { kind: "needs_content"; reason: string; site: string | null };

async function readAttachments(ctx: AiContext, job: JobRow): Promise<{ text: string; illegible: string[] } | null> {
  const attachments = listAttachments(ctx.db, job.id);
  if (!attachments.length) return null;
  const images: PreparedImage[] = [];
  const pdfs: Array<{ bytes: Uint8Array; text: string }> = [];
  for (const a of attachments) {
    const bytes = await readUpload(a.path);
    if (a.kind === "pdf") pdfs.push({ bytes, text: await extractDocumentText("pdf", bytes).catch(() => "") });
    else images.push(...(await prepareScreenshot(bytes)));
  }
  const result = await transcribePosting(ctx, { images, pdfs });
  if (!result.isJobPosting || result.transcription.length < 40) throw new UserFacingError("not_a_job_posting");
  return { text: result.transcription, illegible: result.illegible };
}

export interface ReadUrlOptions extends Pick<ProcessJobOptions, "fetchImpl" | "fetchJson"> {
  /** Enables reading SEEK/LinkedIn pages in the user's browser (when turned on in Settings). */
  browser?: { ctx: Pick<AiContext, "db" | "userId">; signal?: AbortSignal; waitForUser?: TaskContext["waitForUser"] };
}

/** Reads a posting from its link, following the site rules (API, guarded fetch, browser, or "needs content"). */
export async function readJobUrl(url: string, options: ReadUrlOptions = {}): Promise<Content> {
  const parsed = new URL(url);
  const policy = domainPolicy(parsed);
  if (policy.mode === "browser" || policy.mode === "paste") {
    // SEEK/LinkedIn: read in the user's browser window when the site is turned on in Settings.
    const site = options.browser ? browserSiteFor(options.browser.ctx, parsed) : null;
    if (!site || !options.browser) return { kind: "needs_content", reason: `site_${policy.mode}`, site: policy.site };
    try {
      const captured = await readJobInBrowser(options.browser.ctx, site, parsed, { signal: options.browser.signal, waitForUser: options.browser.waitForUser });
      return captured
        ? { kind: "content", text: captured.text, hints: captured.hints, noisy: false, source: site }
        : { kind: "needs_content", reason: "browser_blocked", site };
    } catch (error) {
      if (error instanceof TaskCancelledError) throw error;
      return { kind: "needs_content", reason: errorCodeOf(error) === "browser_unavailable" ? "browser_unavailable" : "browser_blocked", site };
    }
  }
  try {
    const ats = detectAtsUrl(parsed);
    if (ats) {
      const posting = await fetchAtsPosting(ats, options.fetchJson);
      return { kind: "content", text: posting.text, hints: { ...posting.hints, applyUrl: posting.hints.applyUrl ?? posting.sourceUrl }, noisy: false, source: ats.type, ats: { type: ats.type, board: ats.board } };
    }
    // Redirects (e.g. from an aggregator) must not lead into a site Huntloop may not read.
    const page = await safeFetch(url, { fetchImpl: options.fetchImpl, allow: (u) => ["fetch", "api"].includes(domainPolicy(u).mode) });
    const extracted = extractFromHtml(page.body);
    if (extracted.challenge) return { kind: "needs_content", reason: "challenge", site: null };
    if (extracted.shell) return { kind: "needs_content", reason: "shell", site: null };
    return { kind: "content", text: extracted.text, hints: extracted.hints, noisy: !extracted.structured };
  } catch (error) {
    if (error instanceof FetchBlockedError && (error.reason === "private_address" || error.reason === "invalid_url")) throw new UserFacingError("url_blocked");
    if (error instanceof FetchBlockedError && error.reason === "restricted" && error.url) {
      const target = domainPolicy(new URL(error.url));
      return { kind: "needs_content", reason: `site_${target.mode}`, site: target.site };
    }
    return { kind: "needs_content", reason: "fetch_failed", site: null };
  }
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

/**
 * Intake → analysis → assessment → score for one job. Content comes from (in order) stored text,
 * screenshots/PDF transcription, or the URL; sites Huntloop may not read ask the user for content.
 */
export async function processJob(ctx: AiContext, job: JobRow, options: ProcessJobOptions = {}): Promise<JobRow> {
  const stage = (s: JobStage) => options.onStage?.(s);
  const intake: JobIntake = { ...(job.intake ?? {}) };

  if (!options.assessOnly) {
    stage("reading");
    let content: Content | null = null;
    const pasted = job.rawText?.trim() ?? "";

    if (options.preferUrl && job.sourceUrl) {
      const fromUrl = await readJobUrl(job.sourceUrl, { ...options, browser: { ctx, signal: ctx.signal, waitForUser: options.waitForUser } });
      if (fromUrl.kind === "content") content = { ...fromUrl, partial: false };
      else if (job.analysisId) {
        // Keep the existing (provisional) report and say why the full posting couldn't be read.
        return updateJob(ctx.db, job.id, {
          intakeStatus: "ready",
          intakeError: `[full_posting_unavailable] ${fromUrl.reason}`,
          intake: { ...intake, reason: fromUrl.reason, site: fromUrl.site },
        });
      } else content = fromUrl;
    }
    if (!content && options.transcribe) {
      stage("transcribing");
      const transcribed = await readAttachments(ctx, job);
      if (transcribed) {
        const text = [pasted, transcribed.text].filter(Boolean).join("\n\n");
        content = { kind: "content", text, hints: (intake.hints as PostingHints) ?? {}, noisy: !!pasted, illegible: transcribed.illegible };
      }
    }
    if (!content && pasted) content = { kind: "content", text: pasted, hints: (intake.hints as PostingHints) ?? {}, noisy: intake.noisy ?? true, partial: intake.partial };
    if (!content && job.sourceUrl) content = await readJobUrl(job.sourceUrl, { ...options, browser: { ctx, signal: ctx.signal, waitForUser: options.waitForUser } });
    if (!content) throw new UserFacingError("missing_posting");

    if (content.kind === "needs_content") {
      return updateJob(ctx.db, job.id, { intakeStatus: "needs_content", intakeError: null, intake: { ...intake, reason: content.reason, site: content.site } });
    }

    const hints = content.hints;
    job = updateJob(ctx.db, job.id, {
      rawText: content.text,
      source: content.source ?? job.source,
      intake: {
        ...intake,
        hints: hints as JobIntake["hints"],
        noisy: content.noisy,
        reason: undefined,
        site: undefined,
        illegible: content.illegible ?? intake.illegible,
        partial: content.partial ?? false,
      },
    });

    stage("analyzing");
    const analyzed = await analyzePosting(
      ctx,
      { text: content.text, hints, noisy: content.noisy, sourceUrl: job.sourceUrl, excerpt: !!content.partial },
      new Date(),
      { screen: options.screen },
    );
    if (!analyzed.analysis.isJobPosting) throw new UserFacingError("not_a_job_posting");
    const a = analyzed.analysis;
    const companyName = a.company ?? hints.company ?? null;
    const companyId = companyName
      ? upsertCompany(ctx.db, ctx.userId, {
          name: companyName,
          domain: a.companyDomain,
          atsType: content.ats?.type ?? null,
          atsSlug: content.ats?.board ?? null,
          country: a.country,
        })
      : null;
    const city = a.city ?? hints.city ?? null;
    job = updateJob(ctx.db, job.id, {
      analysisId: analyzed.analysisId,
      title: a.title || hints.title || null,
      companyName,
      companyId,
      locationText: a.locationText ?? hints.locationText ?? null,
      city,
      country: a.country,
      workplace: a.workplace,
      employmentType: a.employmentType,
      postedAt: parseDate(a.postedDate) ?? parseDate(hints.postedAt),
      closesAt: parseDate(a.closesDate) ?? parseDate(hints.closesAt),
      applyUrl: hints.applyUrl ? canonicalizeUrl(hints.applyUrl) : (job.applyUrl ?? job.sourceUrl),
      description: analyzed.canonicalText,
      descriptionHash: sha256(analyzed.canonicalText),
      descriptionIsFull: !job.intake?.partial,
      dedupeKey: dedupeKeyFor(companyName, a.title, city),
    });
  }

  const profile = getCurrentProfile(ctx.db, ctx.userId);
  if (profile && job.analysisId) {
    stage("assessing");
    const stored = getStoredAnalysis(ctx, job.analysisId);
    if (stored) {
      const language = userLocale(getLocalUser(ctx.db));
      const assessed = await assessJob(ctx, job.analysisId, { analysis: stored.analysis, profile, language }, new Date(), { screen: options.screen });
      job = updateJob(ctx.db, job.id, { assessmentId: assessed.assessmentId });
    }
  }

  stage("scoring");
  job = updateJob(ctx.db, job.id, { intakeStatus: "ready", intakeError: null });
  rescoreJob(ctx.db, ctx.userId, job);
  stage("done");
  return job;
}
