import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import { migrateTourneyShadow } from "../../../../src/server/supabase/tourneyMigration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const safeEqual = (left, right) => {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return (
    leftBuffer.length === rightBuffer.length &&
    leftBuffer.length > 0 &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
};

const migrationEndpointEnabled = () =>
  ["1", "true", "yes", "on"].includes(
    String(process.env.SUPABASE_MIGRATION_ENDPOINT_ENABLED || "")
      .trim()
      .toLowerCase()
  ) && String(process.env.VERCEL_ENV || "").trim().toLowerCase() !== "production";

const authorized = (request) => {
  const adminKey = String(process.env.REF_ADMIN_KEY || "").trim();
  const cronSecret = String(process.env.CRON_SECRET || "").trim();
  const suppliedAdmin = String(request.headers.get("x-admin-key") || "").trim();
  const bearer = String(request.headers.get("authorization") || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return (
    (adminKey && safeEqual(adminKey, suppliedAdmin)) ||
    (cronSecret && safeEqual(cronSecret, bearer))
  );
};

export async function POST(request) {
  if (!migrationEndpointEnabled()) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  try {
    const result = await migrateTourneyShadow();
    return NextResponse.json(
      { ok: true, ...result },
      { headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    logSafeError("Tourney shadow migration failed", error);
    return NextResponse.json(
      { ok: false, error: "Tourney shadow migration failed." },
      { status: 500, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
