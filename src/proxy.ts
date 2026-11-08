import { NextResponse, type NextRequest } from "next/server";
import { guardRequest } from "@/shared/request-guard";

function hostMessage(host: string | null): string {
  const shown = host === null ? "(none)" : JSON.stringify(host.slice(0, 200));
  return (
    `Huntloop doesn't answer requests for the host ${shown}.\n` +
    "Open it at the address in HUNTLOOP_ORIGIN, at localhost, or add this host to HUNTLOOP_ALLOWED_HOSTS " +
    "(comma-separated host:port) in .env.local and restart.\n"
  );
}

/**
 * Runs before every page, route and Server Function (no matcher on purpose): Host allowlist,
 * cross-site block for state-changing requests, JSON-only chat routes. See src/shared/request-guard.ts.
 */
export function proxy(request: NextRequest) {
  try {
    const verdict = guardRequest(
      { method: request.method, pathname: request.nextUrl.pathname, headers: request.headers },
      { origin: process.env.HUNTLOOP_ORIGIN, allowedHosts: process.env.HUNTLOOP_ALLOWED_HOSTS },
    );
    if (!verdict) return NextResponse.next();
    if (verdict.status === 421) {
      return new NextResponse(hostMessage(request.headers.get("host")), {
        status: 421,
        headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" },
      });
    }
    return NextResponse.json({ error: verdict.error }, { status: verdict.status });
  } catch (error) {
    console.error("[huntloop] request guard failed", error);
    return new NextResponse("Internal error\n", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
