import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { answerTask, cancelTask, getTask } from "@/server/tasks/runner";
import { parseTaskError } from "@/server/errors";

export const runtime = "nodejs";

function ownTask(id: string) {
  const { db, user } = appContext();
  const task = getTask(db, Number(id));
  return task && task.userId === user.id ? { db, task } : null;
}

/** Status of a background task, for polling from the UI. */
export async function GET(_request: NextRequest, ctx: RouteContext<"/api/tasks/[id]">) {
  const found = ownTask((await ctx.params).id);
  if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { task } = found;
  const error = parseTaskError(task.error);
  return NextResponse.json({
    id: task.id,
    kind: task.kind,
    status: task.status,
    progress: task.progress ?? null,
    result: task.result ?? null,
    errorCode: error.code,
    errorMessage: error.message,
  });
}

/** Cancel a queued or running task. */
export async function DELETE(_request: NextRequest, ctx: RouteContext<"/api/tasks/[id]">) {
  const found = ownTask((await ctx.params).id);
  if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
  cancelTask(found.db, found.task.id);
  return NextResponse.json({ ok: true });
}

/** The user's answer to a task waiting for them: { action: "continue" | "skip" }. */
export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/tasks/[id]">) {
  const found = ownTask((await ctx.params).id);
  if (!found) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  if (body.action !== "continue" && body.action !== "skip") return NextResponse.json({ error: "invalid" }, { status: 400 });
  const ok = answerTask(found.db, found.task.id, body.action);
  return NextResponse.json({ ok }, { status: ok ? 200 : 409 });
}
