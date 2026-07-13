import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import {
  applyTourneyV4Activation,
  inventoryTourneyV4Activation,
} from "../../../../src/server/tourney/activation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const noStore = { "Cache-Control": "private, no-store", Pragma: "no-cache" };

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length > 0 && leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
};
const authorized = (request) => {
  const bearer = String(request.headers.get("authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return safeEqual(process.env.CRON_SECRET, bearer);
};
const respond = (body, status = 200) => NextResponse.json(body, {
  status,
  headers: noStore,
});

export async function POST(request) {
  if (!authorized(request)) return respond({ ok: false, error: "Not found." }, 404);
  try {
    const payload = await request.json().catch(() => ({}));
    const action = String(payload.action || "").trim().toLowerCase();
    if (action === "inventory") {
      return respond({ ok: true, ...(await inventoryTourneyV4Activation()) });
    }
    if (action === "apply") {
      return respond({
        ok: true,
        ...(await applyTourneyV4Activation({ inventoryHash: payload.inventoryHash })),
      });
    }
    return respond({ ok: false, error: "Invalid activation action." }, 400);
  } catch (error) {
    logSafeError("Tourney activation failed", error);
    return respond({
      ok: false,
      error: "Tourney activation is not ready.",
      code: String(error?.code || "TOURNEY_ACTIVATION_FAILED").slice(0, 64),
    }, Number(error?.status || 503));
  }
}
