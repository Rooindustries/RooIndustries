import crypto from "node:crypto";

import {
  generateSnapshotTransportKeyPair,
  openSnapshotTransportPayload,
} from "../../src/server/tourney/snapshotTransportCrypto.js";
import { stableSnapshotJson } from "../../src/server/tourney/snapshotContract.js";
import { parseSupabaseDatabaseTargetPayload } from "./supabase-database-target-stdin.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;
const ALLOWED_HOSTS = new Set(["rooindustries.com", "www.rooindustries.com"]);

const transportError = (code) => Object.assign(
  new Error("The Supabase database target transport failed."),
  { code }
);

export const validateDatabaseTargetTransportUrl = (value) => {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    parsed = null;
  }
  if (
    !parsed || parsed.protocol !== "https:" || parsed.port || parsed.username ||
    parsed.password || parsed.search || parsed.hash ||
    parsed.pathname !== "/api/admin/tourney-snapshot-transport" ||
    !ALLOWED_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw transportError("TOURNEY_DATABASE_TARGET_TRANSPORT_URL_INVALID");
  }
  return parsed.toString();
};

const parseResponse = async (response) => {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw transportError("TOURNEY_DATABASE_TARGET_TRANSPORT_RESPONSE_INVALID");
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw transportError("TOURNEY_DATABASE_TARGET_TRANSPORT_RESPONSE_INVALID");
  }
  let result;
  try {
    result = JSON.parse(bytes.toString("utf8"));
  } catch {
    result = null;
  }
  if (!response.ok || result?.ok !== true || !result.envelope) {
    throw transportError(String(
      result?.code || "TOURNEY_DATABASE_TARGET_TRANSPORT_REJECTED"
    ));
  }
  return result.envelope;
};

export const fetchSupabaseDatabaseTarget = async ({
  bearer,
  expectedTargets,
  fetchImpl = fetch,
  transportUrl,
}) => {
  if (Buffer.byteLength(String(bearer || "")) < 32) {
    throw transportError("TOURNEY_DATABASE_TARGET_TRANSPORT_CREDENTIAL_MISSING");
  }
  const pinKeys = Object.keys(expectedTargets || {}).sort();
  const fingerprints = Object.values(expectedTargets || {});
  if (
    stableSnapshotJson(pinKeys) !== stableSnapshotJson([
      "legacy",
      "sanity",
      "supabaseApi",
      "supabaseDatabase",
    ]) ||
    fingerprints.some(
      (value) => !SHA256_PATTERN.test(String(value || ""))
    )
  ) {
    throw transportError("TOURNEY_DATABASE_TARGET_TRANSPORT_PINS_INVALID");
  }
  const requestId = crypto.randomBytes(16).toString("hex");
  const keyPair = generateSnapshotTransportKeyPair();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetchImpl(validateDatabaseTargetTransportUrl(transportUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        action: "database-target",
        requestId,
        publicKey: keyPair.publicKey,
        expectedTargets,
      }),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {
    throw transportError("TOURNEY_DATABASE_TARGET_TRANSPORT_UNAVAILABLE");
  } finally {
    clearTimeout(timeout);
  }
  const envelope = await parseResponse(response);
  const opened = openSnapshotTransportPayload({
    envelope,
    privateKey: keyPair.privateKey,
  });
  if (
    opened.metadata.requestId !== requestId ||
    !REQUEST_ID_PATTERN.test(opened.metadata.requestId) ||
    crypto.createHash("sha256").update(opened.plaintext).digest("hex") !==
      opened.metadata.payloadSha256
  ) {
    throw transportError("TOURNEY_DATABASE_TARGET_TRANSPORT_BINDING_INVALID");
  }
  let payload;
  try {
    payload = JSON.parse(opened.plaintext.toString("utf8"));
  } catch {
    payload = null;
  }
  if (
    stableSnapshotJson(Object.keys(payload || {}).sort()) !==
      stableSnapshotJson([
        "action",
        "expectedFingerprint",
        "requestId",
        "supabaseDatabaseUrl",
      ]) ||
    payload.action !== "database-target" || payload.requestId !== requestId ||
    payload.expectedFingerprint !== expectedTargets.supabaseDatabase
  ) {
    throw transportError("TOURNEY_DATABASE_TARGET_TRANSPORT_PAYLOAD_INVALID");
  }
  return parseSupabaseDatabaseTargetPayload(JSON.stringify({
    expectedFingerprint: payload.expectedFingerprint,
    supabaseDatabaseUrl: payload.supabaseDatabaseUrl,
  }));
};
