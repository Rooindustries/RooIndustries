import path from "node:path";

import {
  loadLegacyApiHandler,
  runLegacyApiHandler,
} from "../../../src/lib/nextApiAdapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const handler = await loadLegacyApiHandler(
    path.join(process.cwd(), "api", "releaseHold.js")
  );
  return runLegacyApiHandler({ request, handler });
}

export async function POST(request) {
  const handler = await loadLegacyApiHandler(
    path.join(process.cwd(), "api", "releaseHold.js")
  );
  return runLegacyApiHandler({ request, handler });
}
