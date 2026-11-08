import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { getJob } from "@/server/repo/jobs";
import { jobTaskRefs } from "@/server/jobs/job-tasks";

export const runtime = "nodejs";

/** The job's background tasks (running and newest per kind), for task controls on a restored page. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/jobs/[id]/tasks">) {
  const { db, user } = appContext();
  const job = getJob(db, user.id, Number((await ctx.params).id));
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(jobTaskRefs(db, user.id, job), { headers: { "cache-control": "no-store" } });
}
