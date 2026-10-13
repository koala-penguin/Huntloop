import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { JOB_STATUSES } from "@/shared/schemas/job";
import type { ModelId } from "@/shared/models";
import { webTools } from "../request";
import { restrictedDomains } from "../../ingest/domain-policy";

/**
 * Tools of the per-job chat. A conversation keeps the toolset it was created with (the tools are
 * part of the cached prompt prefix); bump the version when the set changes.
 */
export const JOB_CHAT_TOOLSET_VERSION = 2;

type Tool = Anthropic.Beta.Messages.BetaTool;
type ToolUnion = Anthropic.Beta.Messages.BetaToolUnion;

const strict = (name: string, description: string, properties: Record<string, unknown>): Tool =>
  ({
    name,
    description,
    strict: true,
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  }) as Tool;

const CLIENT_TOOLS: Tool[] = [
  strict("save_job_note", "Save a short note on this job for the user (decisions, follow-ups, things to remember). Use when the user asks you to remember something, or to record an agreed next step.", {
    note: { type: "string", description: "The note, in the user's language. One or two sentences." },
  }),
  strict("set_job_status", "Change this job's pipeline status. Only when the user tells you their status changed (e.g. they applied, got an interview, were rejected).", {
    status: { type: "string", enum: [...JOB_STATUSES] },
    reason: { type: "string", description: "What the user said that prompted this." },
  }),
  strict(
    "propose_profile_fact",
    "Propose adding a fact about the candidate to their profile, e.g. a skill or experience they told you about that their CV doesn't show. The user sees a confirmation card; nothing is saved unless they accept. Only propose facts the user stated themselves — never infer them.",
    {
      fact: { type: "string", description: "The fact in the user's own words, as a short first-person statement, e.g. \"I ran Kubernetes clusters in production at Harbour Payments for 2 years.\"" },
      why: { type: "string", description: "Which requirement of this job it helps with." },
    },
  ),
  strict(
    "propose_proceed",
    "Propose going ahead with this job (moving it to 'Applying' and preparing the application). Use only when you and the user have agreed it's worth applying. The user confirms on a card.",
    {
      recommendation: { type: "string", description: "One or two sentences: why it's worth applying." },
      concerns: { type: "array", items: { type: "string" }, description: "Open risks to keep in mind (e.g. an unclear eligibility gate). Empty if none." },
    },
  ),
  strict(
    "revise_cv_draft",
    "Ask Huntloop to write a new version of this job's tailored CV draft (shown in the CV tab) — e.g. shorter, a different emphasis, a role brought forward. Only after the candidate has proceeded and a draft exists. Huntloop checks every line of the new version against the CV and confirmed facts.",
    { instructions: { type: "string", description: "What to change, in a sentence or two." } },
  ),
  strict("start_company_research", "Start deep research on this employer in the background (what they do, recent activity, growth, hiring, culture). Results appear on the job page and are shared with you when ready.", {}),
];

export const toolInputSchemas = {
  save_job_note: z.object({ note: z.string().min(1).max(2000) }),
  set_job_status: z.object({ status: z.enum(JOB_STATUSES), reason: z.string().max(2000) }),
  propose_profile_fact: z.object({ fact: z.string().min(3).max(1000), why: z.string().max(1000) }),
  propose_proceed: z.object({ recommendation: z.string().min(1).max(2000), concerns: z.array(z.string().max(500)).max(10) }),
  revise_cv_draft: z.object({ instructions: z.string().min(1).max(2000) }),
  start_company_research: z.object({}),
} as const;
export type ClientToolName = keyof typeof toolInputSchemas;

export function isClientTool(name: string): name is ClientToolName {
  return name in toolInputSchemas;
}

/** Full toolset for a job chat: web search/fetch (restricted job boards blocked) + the client tools. */
export function jobChatTools(model: ModelId, country: string | null): ToolUnion[] {
  const web = webTools(model, {
    searchMaxUses: 5,
    fetchMaxUses: 5,
    blockedDomains: restrictedDomains(),
    userLocation: country ? { country } : undefined,
  });
  // Sorted by name so the serialized tools never change order.
  const name = (t: ToolUnion) => ("name" in t ? String(t.name) : "");
  return [...web, ...CLIENT_TOOLS].sort((a, b) => name(a).localeCompare(name(b)));
}
