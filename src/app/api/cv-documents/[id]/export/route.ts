import { NextResponse, type NextRequest } from "next/server";
import { appContext } from "@/server/context";
import { exportCv } from "@/server/cv/export";
import { errorCodeOf } from "@/server/errors";

export const runtime = "nodejs";

const STATUS: Record<string, number> = { not_found: 404, unresolved_flags: 409, browser_unavailable: 503 };

/** Download a tailored CV: ?format=docx|pdf. */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/cv-documents/[id]/export">) {
  const { id } = await ctx.params;
  const format = request.nextUrl.searchParams.get("format");
  if (format !== "docx" && format !== "pdf") return NextResponse.json({ error: "invalid" }, { status: 400 });
  const { db, user } = appContext();
  try {
    const file = await exportCv(db, user.id, Number(id), format);
    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "content-type": file.mime,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
      },
    });
  } catch (error) {
    const code = errorCodeOf(error);
    if (!code) throw error;
    return NextResponse.json({ error: code }, { status: STATUS[code] ?? 400 });
  }
}
