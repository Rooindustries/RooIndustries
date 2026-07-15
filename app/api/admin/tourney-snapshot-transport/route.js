import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import {
  captureSnapshotTransport,
  inspectSnapshotTransport,
  readSnapshotTransportChunk,
} from "../../../../src/server/tourney/snapshotTransport";
import {
  sealSnapshotTransportPayload,
} from "../../../../src/server/tourney/snapshotTransportCrypto";
import { stableSnapshotJson } from "../../../../src/server/tourney/snapshotContract";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const noStore = { "Cache-Control": "private, no-store", Pragma: "no-cache" };
const REQUEST_ID = /^[0-9a-f]{32}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const safeEqual = (left, right) => {
  const leftBytes = Buffer.from(String(left || ""));
  const rightBytes = Buffer.from(String(right || ""));
  return leftBytes.length > 0 && leftBytes.length === rightBytes.length &&
    crypto.timingSafeEqual(leftBytes, rightBytes);
};

const authorized = (request) => {
  const expected = String(process.env.CRON_SECRET || "");
  if (Buffer.byteLength(expected) < 32) return false;
  return safeEqual(
    String(request.headers.get("authorization") || "")
      .replace(/^Bearer\s+/i, "").trim(),
    expected
  );
};

const respond = (body, status = 200) => NextResponse.json(body, {
  status,
  headers: noStore,
});

const expectedTargets = (payload, { requireDatabase = true } = {}) => {
  const targets = payload?.expectedTargets;
  const values = [targets?.legacy, targets?.sanity, targets?.supabaseApi];
  if (requireDatabase) values.push(targets?.supabaseDatabase);
  if (!targets || values.some((value) => !SHA256.test(String(value || "")))) {
    throw Object.assign(new Error("Snapshot target pins are invalid."), {
      code: "TOURNEY_SNAPSHOT_TARGET_PINS_INVALID",
      status: 400,
    });
  }
  return targets;
};

const sealObject = ({ object, publicKey, requestId, payloadSha256 }) => {
  const plaintext = Buffer.from(stableSnapshotJson(object));
  return sealSnapshotTransportPayload({
    payload: plaintext,
    publicKey,
    metadata: {
      requestId,
      payloadSha256,
      offset: 0,
      totalBytes: plaintext.byteLength,
      chunkBytes: plaintext.byteLength,
    },
  });
};

export async function POST(request) {
  if (!authorized(request)) return respond({ ok: false, error: "Not found." }, 404);
  try {
    const payload = await readBoundedJson(request, {
      maxBytes: 12 * 1024,
      maxDepth: 5,
      maxNodes: 50,
    });
    const action = String(payload.action || "").trim().toLowerCase();
    const requestId = String(payload.requestId || "").trim().toLowerCase();
    if (!REQUEST_ID.test(requestId)) {
      return respond({ ok: false, error: "Invalid snapshot request." }, 400);
    }
    const publicKey = String(payload.publicKey || "");
    if (action === "inspect") {
      const result = await inspectSnapshotTransport({
        expectedTargets: expectedTargets(payload, { requireDatabase: false }),
      });
      const object = { action, requestId, ...result };
      const plaintext = Buffer.from(stableSnapshotJson(object));
      return respond({
        ok: true,
        envelope: sealObject({
          object,
          publicKey,
          requestId,
          payloadSha256: crypto.createHash("sha256").update(plaintext).digest("hex"),
        }),
      });
    }
    if (action === "capture") {
      const result = await captureSnapshotTransport({
        expectedTargets: expectedTargets(payload),
      });
      const object = { action, requestId, ...result };
      return respond({
        ok: true,
        envelope: sealObject({
          object,
          publicKey,
          requestId,
          payloadSha256: result.payloadSha256,
        }),
      });
    }
    if (action === "chunk") {
      const offset = Number(payload.offset);
      const result = await readSnapshotTransportChunk({
        expectedTargets: expectedTargets(payload),
        snapshotId: payload.snapshotId,
        payloadSha256: payload.payloadSha256,
        offset,
      });
      return respond({
        ok: true,
        envelope: sealSnapshotTransportPayload({
          payload: result.chunk,
          publicKey,
          metadata: {
            requestId,
            payloadSha256: String(payload.payloadSha256),
            offset,
            totalBytes: result.totalBytes,
            chunkBytes: result.chunk.byteLength,
          },
        }),
      });
    }
    return respond({ ok: false, error: "Invalid snapshot action." }, 400);
  } catch (error) {
    logSafeError("Tourney snapshot transport failed", error);
    return respond({
      ok: false,
      error: "Tourney snapshot transport is not ready.",
      code: String(error?.code || "TOURNEY_SNAPSHOT_TRANSPORT_FAILED").slice(0, 64),
    }, Number(error?.status || 503));
  }
}
