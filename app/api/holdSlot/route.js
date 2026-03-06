import path from "node:path";

import {
  loadLegacyApiHandler,
  runLegacyApiHandler,
} from "../../../src/lib/nextApiAdapter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(request, methodOverride) {
  const handler = await loadLegacyApiHandler(
    path.join(process.cwd(), "src", "server", "booking", "holdSlot.js")
  );
  return runLegacyApiHandler({ request, handler, methodOverride });
}

export const GET = (request) => handle(request, "GET");
export const POST = (request) => handle(request, "POST");
