import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { requireSupabaseBearerUser } from "../../../../../src/server/supabase/accounts";
import {
  activateEntitlementDevice,
  claimEntitlement,
  getEntitlementStatus,
  licensingErrorResponse,
  revokeEntitlementDevice,
} from "../../../../../src/server/supabase/licensing";
import { logSafeError } from "../../../../../src/server/safeErrorLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

const licensingEnabled = () =>
  TRUE_VALUES.has(
    String(process.env.SUPABASE_LICENSING_ENABLED || "")
      .trim()
      .toLowerCase()
  );

const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
};

const json = (body, status = 200) =>
  noStore(NextResponse.json(body, { status }));

const readJson = async (request) => {
  const contentType = String(request.headers.get("content-type") || "").toLowerCase();
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (!contentType.startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type must be application/json."), {
      status: 415,
    });
  }
  if (contentLength > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    throw Object.assign(new Error("Request body is too large."), { status: 413 });
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("invalid shape");
    }
    return parsed;
  } catch {
    throw Object.assign(new Error("Invalid JSON body."), { status: 400 });
  }
};

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length === rightBuffer.length &&
    leftBuffer.length > 0 &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const requireUser = async (request) => {
  const auth = await requireSupabaseBearerUser({
    authorization: request.headers.get("authorization"),
  });
  if (!auth.ok) {
    return {
      response: json(
        {
          ok: false,
          error:
            auth.reason === "email_not_verified"
              ? "Verify your email before claiming a purchase."
              : "Sign in again to continue.",
        },
        auth.status
      ),
    };
  }
  return { auth };
};

const requireAdministrator = async (request) => {
  const configuredKey = String(process.env.REF_ADMIN_KEY || "").trim();
  const providedKey = String(request.headers.get("x-admin-key") || "").trim();
  if (configuredKey && safeEqual(configuredKey, providedKey)) {
    return { actorUserId: null };
  }

  const result = await requireUser(request);
  if (result.response) return result;
  if (!result.auth.account?.roles?.includes("administrator")) {
    return { response: json({ ok: false, error: "Not found." }, 404) };
  }
  return { actorUserId: result.auth.user.id };
};

const run = async (callback) => {
  try {
    const data = await callback();
    return json({ ok: true, data });
  } catch (error) {
    if ([400, 413, 415].includes(Number(error?.status || 0))) {
      return json({ ok: false, error: error.message }, Number(error.status));
    }
    logSafeError("App licensing request failed", error);
    const response = licensingErrorResponse(error);
    return json({ ok: false, error: response.error }, response.status);
  }
};

export async function GET(request, context) {
  if (!licensingEnabled()) return json({ ok: false, error: "Not found." }, 404);
  const { action } = await context.params;
  if (action !== "status") return json({ ok: false, error: "Not found." }, 404);
  const result = await requireUser(request);
  if (result.response) return result.response;
  return run(() => getEntitlementStatus({ userId: result.auth.user.id }));
}

export async function POST(request, context) {
  if (!licensingEnabled()) return json({ ok: false, error: "Not found." }, 404);
  const { action } = await context.params;
  if (!["claim", "activate", "revoke", "status"].includes(action)) {
    return json({ ok: false, error: "Not found." }, 404);
  }

  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return json(
      { ok: false, error: error.message || "Invalid request." },
      Number(error?.status || 400)
    );
  }

  if (action === "revoke") {
    const administrator = await requireAdministrator(request);
    if (administrator.response) return administrator.response;
    return run(() =>
      revokeEntitlementDevice({
        entitlementId: body.entitlementId,
        requestId: body.requestId,
        reason: body.reason,
        actorUserId: administrator.actorUserId,
      })
    );
  }

  const result = await requireUser(request);
  if (result.response) return result.response;
  if (action === "status") {
    return run(() => getEntitlementStatus({ userId: result.auth.user.id }));
  }
  if (action === "claim") {
    return run(() =>
      claimEntitlement({
        userId: result.auth.user.id,
        verifiedEmail: result.auth.user.email,
        purchaseReference: body.purchaseReference,
      })
    );
  }
  return run(() =>
    activateEntitlementDevice({
      userId: result.auth.user.id,
      entitlementId: body.entitlementId,
      fingerprint: body.hardwareFingerprint,
      requestId: body.requestId,
      deviceLabel: body.deviceLabel,
      appVersion: body.appVersion,
    })
  );
}
