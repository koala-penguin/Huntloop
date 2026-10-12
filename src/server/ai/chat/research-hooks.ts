import type { AiContext } from "../client";
import type { JobRow } from "../../db/schema";

/** How the chat reaches employer research (filled in by the research module). */
export const companyResearchHooks = {
  isReady(_ctx: Pick<AiContext, "db" | "userId">, _job: JobRow): boolean {
    return false;
  },
  start(_ctx: AiContext, _job: JobRow): { ok: boolean; message: string } {
    return { ok: false, message: "Employer research isn't available yet." };
  },
  summaryFor(_ctx: Pick<AiContext, "db" | "userId">, _job: JobRow): string | null {
    return null;
  },
};
