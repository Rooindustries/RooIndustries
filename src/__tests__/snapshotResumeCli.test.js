import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const moduleUrl = (relativePath) => pathToFileURL(
  path.join(process.cwd(), relativePath)
).href;

const runModule = (source) => JSON.parse(execFileSync(process.execPath, [
  "--input-type=module",
  "--eval",
  source,
], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }));

describe("stored Tourney snapshot recovery", () => {
  test("parses a recovery action without legacy or Sanity target access", () => {
    const result = runModule(`
      import fs from "node:fs";
      import fsp from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      import {
        loadEnvironment,
        parseCliAction,
        parseSnapshotResumeMetadata,
      } from ${JSON.stringify(moduleUrl("scripts/tourney-cutover.mjs"))};
      const id = "10000000-0000-4000-8000-000000000001";
      const hash = "3".repeat(64);
      process.argv = ["node", "script", "--snapshot-id", id, "--snapshot-sha256", hash];
      const discovered = parseSnapshotResumeMetadata();
      process.argv = [
        "node", "script", "--snapshot-id", id, "--snapshot-sha256", hash,
        "--snapshot-total-bytes", "87150569",
      ];
      const pinned = parseSnapshotResumeMetadata();
      process.argv = [
        "node", "script", "--resume-snapshot-via-production",
        "--env", "/private/tmp/private.env",
        "--snapshot-id", id,
        "--snapshot-sha256", hash,
        "--snapshot-transport-url",
        "https://www.rooindustries.com/api/admin/tourney-snapshot-transport",
      ];
      const action = parseCliAction();
      process.argv = [
        "node", "script", "--snapshot-id", id, "--snapshot-sha256", hash,
        "--snapshot-total-bytes", "134217729",
      ];
      let oversized;
      try { parseSnapshotResumeMetadata(); } catch (error) { oversized = error.code; }
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "snapshot-env-test-"));
      const envPath = path.join(root, "private.env");
      await fsp.writeFile(envPath, "NODE_ENV=production\\n", { mode: 0o600 });
      process.env.CRON_SECRET = "ambient-secret-must-not-survive";
      process.argv = ["node", "script", "--env", envPath];
      loadEnvironment();
      const ambientCronSecretRemoved = process.env.CRON_SECRET === undefined;
      const source = fs.readFileSync(${JSON.stringify(path.join(
        process.cwd(),
        "scripts/tourney-cutover.mjs"
      ))}, "utf8");
      const recoveryBody = source.slice(
        source.indexOf("const resumeSnapshotViaProduction"),
        source.indexOf("const captureSnapshot =")
      );
      process.stdout.write(JSON.stringify({
        discovered,
        pinned,
        action: {
          flag: action.flag,
          requiresEnvironment: action.requiresEnvironment,
          touchesLegacy: action.touchesLegacy,
          touchesSupabase: action.touchesSupabase,
          touchesSanity: action.touchesSanity,
        },
        oversized,
        readsLegacy: recoveryBody.includes("readLegacySnapshot"),
        readsSanity: recoveryBody.includes("readSanityAccountDocument"),
        removesFailedOutput: recoveryBody.includes("fs.unlinkSync(reservation.output)"),
        removesFailedKey: recoveryBody.includes("deleteSnapshotSecret(archive?.keychainService)"),
        ambientCronSecretRemoved,
      }));
      await fsp.rm(root, { recursive: true, force: true });
    `);
    expect(result).toEqual({
      discovered: {
        snapshotId: "10000000-0000-4000-8000-000000000001",
        payloadSha256: "3".repeat(64),
      },
      pinned: {
        snapshotId: "10000000-0000-4000-8000-000000000001",
        payloadSha256: "3".repeat(64),
        totalBytes: 87150569,
      },
      action: {
        flag: "--resume-snapshot-via-production",
        requiresEnvironment: true,
        touchesLegacy: false,
        touchesSupabase: false,
        touchesSanity: false,
      },
      oversized: "TOURNEY_SNAPSHOT_RESUME_METADATA_INVALID",
      readsLegacy: false,
      readsSanity: false,
      removesFailedOutput: true,
      removesFailedKey: true,
      ambientCronSecretRemoved: true,
    });
  });

  test("discovers the exact byte length and rejects malformed chunk progress", () => {
    const result = runModule(`
      import crypto from "node:crypto";
      import { SNAPSHOT_TRANSPORT_CHUNK_BYTES } from ${JSON.stringify(
        moduleUrl("src/server/tourney/snapshotTransport.js")
      )};
      import { downloadTransportSnapshot } from ${JSON.stringify(
        moduleUrl("scripts/tourney-cutover.mjs")
      )};
      const bytes = Buffer.alloc(SNAPSHOT_TRANSPORT_CHUNK_BYTES + 17, 97);
      const capture = {
        snapshotId: "10000000-0000-4000-8000-000000000001",
        payloadSha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
      const offsets = [];
      const chunks = async ({ body }) => {
        offsets.push(body.offset);
        const chunk = bytes.subarray(
          body.offset,
          Math.min(body.offset + SNAPSHOT_TRANSPORT_CHUNK_BYTES, bytes.length)
        );
        return {
          plaintext: chunk,
          metadata: {
            payloadSha256: capture.payloadSha256,
            offset: body.offset,
            totalBytes: bytes.length,
            chunkBytes: chunk.length,
          },
        };
      };
      const payload = await downloadTransportSnapshot({
        capture,
        expected: { pinned: true },
        keyPair: {},
        postTransport: chunks,
      });
      const captureError = async (postTransport, metadata = capture) => {
        try {
          await downloadTransportSnapshot({
            capture: metadata,
            expected: {},
            keyPair: {},
            postTransport,
          });
          return "accepted";
        } catch (error) {
          return error.code;
        }
      };
      const zero = await captureError(async () => ({
        plaintext: Buffer.alloc(0),
        metadata: {
          payloadSha256: capture.payloadSha256,
          offset: 0,
          totalBytes: bytes.length,
          chunkBytes: 0,
        },
      }));
      const short = await captureError(async () => ({
        plaintext: Buffer.alloc(1),
        metadata: {
          payloadSha256: capture.payloadSha256,
          offset: 0,
          totalBytes: bytes.length,
          chunkBytes: 1,
        },
      }));
      const totalMismatch = await captureError(chunks, {
        ...capture,
        totalBytes: bytes.length + 1,
      });
      const wrongHashCapture = { ...capture, payloadSha256: "0".repeat(64) };
      const wrongHash = await captureError(async ({ body }) => {
        const chunk = bytes.subarray(
          body.offset,
          Math.min(body.offset + SNAPSHOT_TRANSPORT_CHUNK_BYTES, bytes.length)
        );
        return {
          plaintext: chunk,
          metadata: {
            payloadSha256: body.payloadSha256,
            offset: body.offset,
            totalBytes: bytes.length,
            chunkBytes: chunk.length,
          },
        };
      }, wrongHashCapture);
      let changingTotalCalls = 0;
      const changingTotal = await captureError(async ({ body }) => {
        changingTotalCalls += 1;
        const chunk = bytes.subarray(
          body.offset,
          Math.min(body.offset + SNAPSHOT_TRANSPORT_CHUNK_BYTES, bytes.length)
        );
        return {
          plaintext: chunk,
          metadata: {
            payloadSha256: body.payloadSha256,
            offset: body.offset,
            totalBytes: bytes.length + (changingTotalCalls > 1 ? 1 : 0),
            chunkBytes: chunk.length,
          },
        };
      });
      process.stdout.write(JSON.stringify({
        roundTrip: payload === bytes.toString("utf8"),
        offsets,
        zero,
        short,
        totalMismatch,
        wrongHash,
        changingTotal,
      }));
    `);
    expect(result).toEqual({
      roundTrip: true,
      offsets: [0, 524288, 0],
      zero: "TOURNEY_SNAPSHOT_TRANSPORT_CHUNK_INVALID",
      short: "TOURNEY_SNAPSHOT_TRANSPORT_CHUNK_INVALID",
      totalMismatch: "TOURNEY_SNAPSHOT_TRANSPORT_CHUNK_INVALID",
      wrongHash: "TOURNEY_SNAPSHOT_TRANSPORT_HASH_MISMATCH",
      changingTotal: "TOURNEY_SNAPSHOT_TRANSPORT_CHUNK_INVALID",
    });
  });

  test("builds one verbatim hosted archive and cleans up its Keychain key on failure", () => {
    const result = runModule(`
      import crypto from "node:crypto";
      import fs from "node:fs";
      import fsp from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      import {
        buildTransportSnapshotBundle,
        decryptSnapshot,
        HOSTED_SNAPSHOT_RELATIONS,
        LEGACY_TABLES,
        stableJson,
        verifySnapshot,
        writeTransportSnapshotArchive,
      } from ${JSON.stringify(moduleUrl("scripts/tourney-cutover.mjs"))};
      import {
        SUPABASE_FULL_EXPANDED_PROFILE,
        SUPABASE_FULL_REQUIRED_RELATIONS,
        SUPABASE_FULL_SNAPSHOT_SCHEMAS,
      } from ${JSON.stringify(moduleUrl("src/server/tourney/snapshotContract.js"))};
      const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
      const legacy = Object.fromEntries(LEGACY_TABLES.map((table) => [table, []]));
      const sanity = { _id: "tourneyAuthStore", _type: "tourneyAuthStore", version: 4 };
      const relationPayloads = Object.fromEntries(
        SUPABASE_FULL_REQUIRED_RELATIONS.map((relation) => [
          relation,
          relation === "auth.users" ? "[{\\"id\\":\\"global-1\\"},{\\"id\\":\\"global-2\\"}]" : "[]",
        ])
      );
      const relationCounts = Object.fromEntries(
        Object.entries(relationPayloads).map(([relation, rows]) => [
          relation,
          JSON.parse(rows).length,
        ])
      );
      const relationHashes = Object.fromEntries(
        Object.entries(relationPayloads).map(([relation, rows]) => [relation, hash(rows)])
      );
      const catalogRelations = Object.keys(relationPayloads).sort();
      const payload = Object.fromEntries(
        HOSTED_SNAPSHOT_RELATIONS.map((relation) => [
          relation,
          relation === "auth.users" ? [{ id: "tourney-1" }] : [],
        ])
      );
      payload.legacy = legacy;
      payload.sanity_account = sanity;
      payload.full_logical = {
        format: "roo-supabase-full-logical-snapshot-v1",
        capturedAt: "2026-07-15T05:32:33.727Z",
        sourceSnapshotId: "9f3bce71-174f-48f1-afe3-c22d62c89e73",
        sourceMigrationVersion: "20260715130100",
        contractProfile: SUPABASE_FULL_EXPANDED_PROFILE,
        schemas: [...SUPABASE_FULL_SNAPSHOT_SCHEMAS],
        requiredRelations: [...SUPABASE_FULL_REQUIRED_RELATIONS],
        deferredRelations: [],
        catalogRelations,
        catalogSha256: hash(stableJson(catalogRelations)),
        relationPayloads,
        relationCounts,
        relationHashes,
      };
      const payloadText = JSON.stringify(payload, null, 1);
      const capture = {
        snapshotId: "10000000-0000-4000-8000-000000000001",
        payloadSha256: hash(payloadText),
      };
      const { hostedTableCounts, logicalProof, snapshot } = buildTransportSnapshotBundle({
        capturedAt: "2026-07-15T06:30:00.000Z",
        capture,
        payloadText,
      });
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "snapshot-resume-test-"));
      const output = path.join(root, "recovered.enc");
      const descriptor = fs.openSync(output, "wx", 0o600);
      let stored;
      const archive = await writeTransportSnapshotArchive({
        capturedAt: snapshot.capturedAt,
        reservation: { output, descriptor },
        snapshot,
        storeSecret: async (value) => { stored = value; },
        deleteSecret: async () => {},
      });
      fs.closeSync(descriptor);
      const decrypted = decryptSnapshot({
        encrypted: fs.readFileSync(output),
        secret: stored.secret,
      });
      process.argv = ["node", "script", "--verify-snapshot", output];
      const verified = await verifySnapshot({
        allowedRoot: root,
        secretEnv: { TOURNEY_SNAPSHOT_KEY: stored.secret },
      });
      const failedOutput = path.join(root, "failed.enc");
      const closedDescriptor = fs.openSync(failedOutput, "wx", 0o600);
      fs.closeSync(closedDescriptor);
      let deleted = "";
      let failureCode = "";
      try {
        await writeTransportSnapshotArchive({
          capturedAt: snapshot.capturedAt,
          reservation: { output: failedOutput, descriptor: closedDescriptor },
          snapshot,
          storeSecret: async () => {},
          deleteSecret: async (service) => { deleted = service; },
        });
      } catch (error) {
        failureCode = error.code || error.name;
      }
      const mode = (fs.statSync(output).mode & 0o777).toString(8);
      process.stdout.write(JSON.stringify({
        capturedAt: snapshot.capturedAt,
        recoveredAt: snapshot.recoveredAt,
        legacyPayloadEncoding: snapshot.legacyPayloadEncoding,
        payloadVerbatim: snapshot.supabase.payloadText === payloadText,
        payloadObjectOmitted: snapshot.supabase.payload === undefined,
        partialAuthUsers: snapshot.supabase.hostedTableCounts["auth.users"],
        logicalAuthUsers: logicalProof.rowCount,
        mergedAuthUsers: snapshot.supabase.tableCounts["auth.users"],
        relationCount: logicalProof.relationCount,
        mode,
        archiveMatches: archive.encrypted.equals(fs.readFileSync(output)),
        decryptedMatches: stableJson(decrypted) === stableJson(snapshot),
        verifiedRecovered: verified.recoveredFromStoredSnapshot,
        verifiedSnapshotId: verified.supabaseSnapshotId,
        failureCode,
        keyDeleted: deleted.startsWith("RooIndustries-Tourney-Snapshot-"),
      }));
      await fsp.rm(root, { recursive: true, force: true });
    `);
    expect(result).toEqual({
      capturedAt: "2026-07-15T05:32:33.727Z",
      recoveredAt: "2026-07-15T06:30:00.000Z",
      legacyPayloadEncoding: "normalized-hosted-json",
      payloadVerbatim: true,
      payloadObjectOmitted: true,
      partialAuthUsers: 1,
      logicalAuthUsers: 2,
      mergedAuthUsers: 2,
      relationCount: expect.any(Number),
      mode: "600",
      archiveMatches: true,
      decryptedMatches: true,
      verifiedRecovered: true,
      verifiedSnapshotId: "10000000-0000-4000-8000-000000000001",
      failureCode: "EBADF",
      keyDeleted: true,
    });
    expect(result.relationCount).toBeGreaterThan(80);
  });
});
