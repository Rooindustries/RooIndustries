import { startServerMonitoring } from "@/src/lib/monitoring/server";
import { logSafeError } from "@/src/server/safeErrorLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request) {
  if (new URL(request.url).searchParams.has("request")) {
    return Response.json({ url: request.url, host: request.headers.get("host"), origin: request.headers.get("origin") });
  }
  if (new URL(request.url).searchParams.has("direct")) {
    startServerMonitoring(process.env.NEXT_PUBLIC_SENTRY_DSN);
    logSafeError("Fixture server direct", new Error("Fixture private server message"));
    return Response.json({ triggered: true });
  }
  throw new Error("Fixture server uncaught");
}
