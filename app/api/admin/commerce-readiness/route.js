import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient";
import { resolveSupabaseRuntimePolicy } from "../../../../src/server/supabase/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const preferredRegion = "dub1";

const noStore = { "Cache-Control": "private, no-store", Pragma: "no-cache" };

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length > 0 &&
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const authorized = (request) => {
  const configured = String(process.env.REF_ADMIN_KEY || "").trim();
  const supplied = String(request.headers.get("x-admin-key") || "").trim();
  return configured && safeEqual(configured, supplied);
};

export async function GET(request) {
  if (!authorized(request)) {
    return NextResponse.json(
      { ok: false, error: "Not found." },
      { status: 404, headers: noStore }
    );
  }

  try {
    const policy = resolveSupabaseRuntimePolicy();
    const { data, error } = await createSupabaseAdminClient().rpc(
      "roo_commerce_readiness"
    );
    if (error) throw Object.assign(new Error("Readiness query failed."), error);
    return NextResponse.json(
      {
        ok: true,
        primaryBackend: policy.commercePrimaryBackend,
        cutoverEnabled: policy.commerceCutoverEnabled,
        startsPaused: policy.commerceStartsPaused,
        failoverGeneration: policy.commerceFailoverGeneration,
        ...data,
      },
      { headers: noStore }
    );
  } catch (error) {
    logSafeError("Commerce readiness check failed", error);
    return NextResponse.json(
      { ok: false, error: "Commerce readiness is unavailable." },
      { status: 503, headers: noStore }
    );
  }
}
