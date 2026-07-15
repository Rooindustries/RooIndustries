import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import {
  flushCreatorTermsMirror,
  getCreatorTermsHistory,
  listCreatorTerms,
  updateCreatorTerms,
} from "../../../../src/server/referrals/creatorTerms";
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

const authorized = (request) =>
  safeEqual(process.env.REF_ADMIN_KEY, request.headers.get("x-admin-key"));

const responseError = (error) => {
  const code = String(error?.code || "");
  const requestedStatus = Number(error?.status || error?.statusCode || 0);
  if (requestedStatus >= 400 && requestedStatus < 500) return requestedStatus;
  if (["40001", "23505"].includes(code)) return 409;
  if (code === "P0002") return 404;
  if (code === "22023") return 400;
  return 503;
};

const notFound = () =>
  NextResponse.json(
    { ok: false, error: "Not found." },
    { status: 404, headers: noStore }
  );

const readBoundedInteger = (value, { fallback, min, max }) => {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(String(value))) {
    const error = new Error("The creator page is invalid.");
    error.status = 400;
    throw error;
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    const error = new Error("The creator page is invalid.");
    error.status = 400;
    throw error;
  }
  return number;
};

const readInput = async (request) => {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 8192) {
    const oversized = new Error("Request body is too large.");
    oversized.status = 413;
    throw oversized;
  }
  try {
    const input = JSON.parse(text);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
    return input;
  } catch {
    const invalidBody = new Error("A valid JSON body is required.");
    invalidBody.status = 400;
    throw invalidBody;
  }
};

const publicUpdateError = (status, error) => {
  if (status === 409) {
    return "This creator changed in another session. Reload and try again.";
  }
  if (status === 400) return error.message;
  if (status === 413) return "Request body is too large.";
  if (status === 404) return "Creator not found.";
  return "Creator settings could not be saved right now.";
};

export async function GET(request) {
  if (!authorized(request)) return notFound();
  try {
    const url = new URL(request.url);
    const creatorId = String(url.searchParams.get("creatorId") || "").trim();
    const search = url.searchParams.get("search") || "";
    const offset = readBoundedInteger(url.searchParams.get("offset"), {
      fallback: 0,
      min: 0,
      max: 1_000_000,
    });
    const pageSize = readBoundedInteger(url.searchParams.get("limit"), {
      fallback: 50,
      min: 1,
      max: 100,
    });
    const client = createSupabaseAdminClient();
    const [creators, history] = await Promise.all([
      listCreatorTerms({ client, search, limit: pageSize + 1, offset }),
      creatorId
        ? getCreatorTermsHistory({ client, creatorId })
        : Promise.resolve([]),
    ]);
    const creatorRows = Array.isArray(creators) ? creators : [];
    return NextResponse.json(
      {
        ok: true,
        creators: creatorRows.slice(0, pageSize),
        history: history || [],
        hasMore: creatorRows.length > pageSize,
        nextOffset: offset + Math.min(pageSize, creatorRows.length),
      },
      { headers: noStore }
    );
  } catch (error) {
    logSafeError("Referral creator editor read failed", error);
    return NextResponse.json(
      { ok: false, error: "Creator settings are temporarily unavailable." },
      { status: responseError(error), headers: noStore }
    );
  }
}

export async function PATCH(request) {
  if (!authorized(request)) return notFound();
  try {
    const input = await readInput(request);
    const client = createSupabaseAdminClient();
    const policy = resolveSupabaseRuntimePolicy();
    const creator = await updateCreatorTerms({
      client,
      input,
      cutoverGeneration: policy.commerceFailoverGeneration,
    });
    const mirror = await flushCreatorTermsMirror({
      client,
      legacySanityId: creator?.legacy_sanity_id,
    });
    return NextResponse.json(
      { ok: true, creator, ...mirror },
      { headers: noStore }
    );
  } catch (error) {
    logSafeError("Referral creator editor update failed", error);
    const status = responseError(error);
    return NextResponse.json(
      { ok: false, error: publicUpdateError(status, error) },
      { status, headers: noStore }
    );
  }
}
