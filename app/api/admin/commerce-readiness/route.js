import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient";
import { resolveSupabaseRuntimePolicy } from "../../../../src/server/supabase/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
    const client = createSupabaseAdminClient();
    const [readinessResult, integrityResult, portResult] = await Promise.all([
      client.rpc("roo_commerce_readiness"),
      client.rpc("roo_commerce_integrity_readiness"),
      client.rpc("roo_supabase_port_readiness"),
    ]);
    if (readinessResult.error || integrityResult.error || portResult.error) {
      throw Object.assign(
        new Error("Readiness query failed."),
        readinessResult.error || integrityResult.error || portResult.error
      );
    }
    const readiness = readinessResult.data || {};
    const integrity = integrityResult.data || {};
    const databaseControl = integrity.control || {};
    return NextResponse.json(
      {
        ok: true,
        ...readiness,
        primaryBackend: policy.commercePrimaryBackend,
        cutoverEnabled: policy.commerceCutoverEnabled,
        startsPaused: policy.commerceStartsPaused,
        failoverGeneration: policy.commerceFailoverGeneration,
        databaseControl,
        controlMatchesDeployment:
          String(databaseControl.primary_backend || "") ===
            policy.commercePrimaryBackend &&
          Number(databaseControl.generation) ===
            policy.commerceFailoverGeneration &&
          Boolean(databaseControl.starts_paused) === policy.commerceStartsPaused,
        integrity: {
          mirror: integrity.mirror || {},
          orphanClaimedProofs: Number(integrity.orphan_claimed_proofs || 0),
          orphanFreeProofs: Number(integrity.orphan_free_proofs || 0),
          commandConflicts: Number(integrity.command_conflicts || 0),
          fullProjectorCallsInCommands: Number(
            integrity.full_projector_calls_in_commands || 0
          ),
        },
        portClosure: portResult.data || {},
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
