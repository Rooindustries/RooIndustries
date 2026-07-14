import { NextResponse } from "next/server";
import { authorizeCronRequest } from "../../../../src/server/api/cronAuth";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { getSafeErrorCode, logSafeError } from "../../../../src/server/safeErrorLog";
import { repairTourneyEmailDispatch } from "../../../../src/server/tourney/emailDispatch";
import { repairTourneyExternalOperation } from "../../../../src/server/tourney/externalOperations";
import {
  runTourneyReconciliation,
  TOURNEY_RECONCILIATION_BUDGET_MS,
} from "../../../../src/server/tourney/reconcile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store", Pragma: "no-cache" };
const respond = (body, status = 200) => NextResponse.json(body, {
  status,
  headers: noStore,
});
const failureStatus = (error) => {
  const status = Number(error?.status || 503);
  return status >= 400 && status <= 599 ? status : 503;
};
const REPAIR_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTERNAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const requestError = (message, code = "TOURNEY_REPAIR_REQUEST_INVALID") =>
  Object.assign(new Error(message), { code, status: 400 });

const assertExactKeys = (payload, allowed) => {
  const unexpected = Object.keys(payload).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw requestError("Unexpected repair request field.");
};

const requireRepairToken = (payload, field, maxLength) => {
  const value = payload[field];
  if (
    typeof value !== "string" || value.length < 3 || value.length > maxLength ||
    value !== value.trim() || !REPAIR_TOKEN_PATTERN.test(value)
  ) {
    throw requestError(`Invalid ${field}.`, `TOURNEY_REPAIR_${field.toUpperCase()}_INVALID`);
  }
  return value;
};

const parseRepairRequest = (payload) => {
  const action = payload.action;
  if (!["rearm_external_operation", "rearm_email_dispatch"].includes(action)) {
    throw requestError("Unsupported repair action.", "TOURNEY_REPAIR_ACTION_INVALID");
  }
  const actor = requireRepairToken(payload, "actor", 64);
  const reason = requireRepairToken(payload, "reason", 128);
  if (action === "rearm_external_operation") {
    assertExactKeys(payload, new Set(["action", "actor", "reason", "operationKey"]));
    if (
      typeof payload.operationKey !== "string" ||
      payload.operationKey.length < 16 || payload.operationKey.length > 512 ||
      payload.operationKey !== payload.operationKey.trim() ||
      !EXTERNAL_KEY_PATTERN.test(payload.operationKey)
    ) {
      throw requestError("Invalid external operation target.", "TOURNEY_REPAIR_TARGET_INVALID");
    }
    return { action, actor, reason, operationKey: payload.operationKey };
  }
  assertExactKeys(payload, new Set([
    "action", "actor", "reason", "dispatchId", "historicalOverride",
  ]));
  if (typeof payload.dispatchId !== "string" || !UUID_PATTERN.test(payload.dispatchId)) {
    throw requestError("Invalid email dispatch target.", "TOURNEY_REPAIR_TARGET_INVALID");
  }
  if (
    payload.historicalOverride !== undefined &&
    typeof payload.historicalOverride !== "boolean"
  ) {
    throw requestError(
      "Invalid historical override.",
      "TOURNEY_EMAIL_REPAIR_OVERRIDE_INVALID"
    );
  }
  return {
    action,
    actor,
    dispatchId: payload.dispatchId,
    historicalOverride: payload.historicalOverride === true,
    reason,
  };
};

export async function GET(request) {
  try {
    authorizeCronRequest(request);
  } catch (error) {
    return respond({
      ok: false,
      error: "Tournament reconciliation is temporarily unavailable.",
    }, failureStatus(error));
  }

  try {
    const result = await runTourneyReconciliation({
      budgetMs: TOURNEY_RECONCILIATION_BUDGET_MS,
    });
    return respond({ ok: true, ...result });
  } catch (error) {
    logSafeError("Tourney reconciliation cron failed", error);
    return respond({
      ok: false,
      error: "Tournament reconciliation is temporarily unavailable.",
      code: getSafeErrorCode(error, "tourney_reconciliation_failed"),
      failedStage: String(error?.failedStage || "tourneyUnknown").slice(0, 64),
      summary: error?.partialSummary || {},
    }, failureStatus(error));
  }
}

export async function POST(request) {
  try {
    authorizeCronRequest(request);
  } catch (error) {
    return respond({
      ok: false,
      error: "Tournament reconciliation is temporarily unavailable.",
    }, failureStatus(error));
  }

  try {
    const command = parseRepairRequest(await readBoundedJson(request, {
      maxBytes: 4 * 1024,
      maxDepth: 2,
      maxNodes: 16,
    }));
    const result = command.action === "rearm_external_operation"
      ? await repairTourneyExternalOperation(command)
      : await repairTourneyEmailDispatch(command);
    return respond({
      ok: true,
      action: command.action,
      audited: true,
      previousStatus: result.previousStatus,
      status: result.status,
      targetHash: result.targetHash,
    });
  } catch (error) {
    const status = failureStatus(error);
    if (status >= 500) logSafeError("Tourney queue repair failed", error);
    return respond({
      ok: false,
      error: "Tournament repair request was rejected.",
      code: getSafeErrorCode(error, "TOURNEY_REPAIR_FAILED"),
    }, status);
  }
}
