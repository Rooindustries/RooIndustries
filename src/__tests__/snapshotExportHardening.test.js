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

describe("encrypted export hardening", () => {
  test("seals transport chunks to a one-time RSA key and rejects tampering", () => {
    const result = runModule(`
      import {
        generateSnapshotTransportKeyPair,
        openSnapshotTransportPayload,
        sealSnapshotTransportPayload,
      } from ${JSON.stringify(moduleUrl("src/server/tourney/snapshotTransportCrypto.js"))};
      const keys = generateSnapshotTransportKeyPair();
      const payload = Buffer.from("verified snapshot chunk");
      const metadata = {
        requestId: "a".repeat(32),
        payloadSha256: "b".repeat(64),
        offset: 0,
        totalBytes: payload.length,
        chunkBytes: payload.length,
      };
      const envelope = sealSnapshotTransportPayload({
        payload,
        publicKey: keys.publicKey,
        metadata,
      });
      const opened = openSnapshotTransportPayload({ envelope, privateKey: keys.privateKey });
      const tampered = structuredClone(envelope);
      const ciphertext = Buffer.from(tampered.ciphertext, "base64");
      ciphertext[0] ^= 1;
      tampered.ciphertext = ciphertext.toString("base64");
      let tamperRejected = false;
      try {
        openSnapshotTransportPayload({ envelope: tampered, privateKey: keys.privateKey });
      } catch {
        tamperRejected = true;
      }
      process.stdout.write(JSON.stringify({
        roundTrip: opened.plaintext.equals(payload),
        requestBound: opened.metadata.requestId === metadata.requestId,
        tamperRejected,
      }));
    `);
    expect(result).toEqual({
      roundTrip: true,
      requestBound: true,
      tamperRejected: true,
    });
  });

  test("requires private env files and exactly verifies authenticated archives", () => {
    const result = runModule(`
      import fs from "node:fs";
      import fsp from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      import {
        decryptJsonExport,
        encryptJsonExport,
        encryptTarDirectory,
        loadPrivateExportEnvironment,
        parseExportArguments,
        reserveExportOutput,
        verifyEncryptedTarArchive,
      } from ${JSON.stringify(moduleUrl("scripts/lib/encrypted-export.mjs"))};
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "export-hardening-test-"));
      const validEnv = path.join(root, "valid.env");
      const insecureEnv = path.join(root, "insecure.env");
      await fsp.writeFile(validEnv, "SUPABASE_URL=https://pinned.supabase.co\\n", { mode: 0o600 });
      await fsp.writeFile(insecureEnv, "SUPABASE_URL=https://wrong.supabase.co\\n", { mode: 0o644 });
      const capture = (operation) => {
        try { return operation(); } catch (error) { return error.code; }
      };
      const env = { SUPABASE_URL: "https://ambient.invalid" };
      const args = parseExportArguments(["--env", validEnv]);
      loadPrivateExportEnvironment({
        envPath: args.envPath,
        prefixes: ["SUPABASE_"],
        env,
      });
      const insecure = capture(() => loadPrivateExportEnvironment({
        envPath: insecureEnv,
        prefixes: ["SUPABASE_"],
        env: {},
      }));
      const missing = capture(() => parseExportArguments([]));
      const first = reserveExportOutput({
        prefix: "Snapshot",
        extension: "enc",
        root,
        now: new Date("2026-07-15T00:00:00.000Z"),
      });
      const second = reserveExportOutput({
        prefix: "Snapshot",
        extension: "enc",
        root,
        now: new Date("2026-07-15T00:00:00.000Z"),
      });
      const modes = [first, second].map((entry) => {
        const mode = (fs.fstatSync(entry.descriptor).mode & 0o777).toString(8);
        fs.closeSync(entry.descriptor);
        return mode;
      });
      const passphrase = "private-passphrase-32-bytes-minimum";
      const encryptedJson = encryptJsonExport({ payload: { nested: [1, 2] }, passphrase });
      const decryptedJson = decryptJsonExport({ encrypted: encryptedJson, passphrase });
      const stage = path.join(root, "stage");
      await fsp.mkdir(stage);
      await fsp.mkdir(path.join(stage, "assets"));
      await fsp.writeFile(path.join(stage, "documents.json"), "[]");
      await fsp.writeFile(path.join(stage, "manifest.json"), "{}");
      await fsp.writeFile(path.join(stage, "assets", "one.bin"), "asset bytes");
      const archive = path.join(root, "archive.enc");
      const created = await encryptTarDirectory({ directory: stage, outputPath: archive, passphrase });
      const verified = await verifyEncryptedTarArchive({
        inputPath: archive,
        passphrase,
        expectedEntries: ["", "assets", "assets/one.bin", "documents.json", "manifest.json"],
      });
      const tampered = await fsp.readFile(archive);
      tampered[60] ^= 1;
      const badArchive = path.join(root, "bad.enc");
      await fsp.writeFile(badArchive, tampered);
      let tamperRejected = false;
      try {
        await verifyEncryptedTarArchive({ inputPath: badArchive, passphrase });
      } catch {
        tamperRejected = true;
      }
      process.stdout.write(JSON.stringify({
        loaded: env.SUPABASE_URL,
        insecure,
        missing,
        unique: first.outputPath !== second.outputPath,
        modes,
        jsonRoundTrip: decryptedJson.nested.join(",") === "1,2",
        archiveHashMatch: created.plaintextSha256 === verified.plaintextSha256,
        tamperRejected,
      }));
      await fsp.rm(root, { recursive: true, force: true });
    `);
    expect(result).toEqual({
      loaded: "https://pinned.supabase.co",
      insecure: "EXPORT_ENV_INVALID",
      missing: "EXPORT_ENV_REQUIRED",
      unique: true,
      modes: ["600", "600"],
      jsonRoundTrip: true,
      archiveHashMatch: true,
      tamperRejected: true,
    });
  });

  test("requires complete Sanity assets and deep commerce snapshot structure", () => {
    const result = runModule(`
      import crypto from "node:crypto";
      import fsp from "node:fs/promises";
      import os from "node:os";
      import path from "node:path";
      import {
        downloadSanityExportAssets,
        fetchAllSanityDocuments,
        validateSanityExportDocuments,
      } from ${JSON.stringify(moduleUrl("scripts/export-sanity-encrypted.mjs"))};
      import {
        SNAPSHOT_ARRAYS,
        validateCommerceExportSnapshot,
      } from ${JSON.stringify(moduleUrl("scripts/export-supabase-commerce-encrypted.mjs"))};
      const bytes = Buffer.from("complete asset bytes");
      const pagedDocuments = Array.from({ length: 501 }, (_, index) => ({
        _id: "doc-" + String(index).padStart(4, "0"),
        _type: "fixture",
      }));
      let pageCalls = 0;
      const allDocuments = await fetchAllSanityDocuments({
        fetch: async (_query, { after }) => {
          pageCalls += 1;
          return pagedDocuments.filter((document) => document._id > after).slice(0, 500);
        },
      });
      const sha1 = crypto.createHash("sha1").update(bytes).digest("hex");
      const assetId = "file-" + sha1 + "-txt";
      const asset = {
        _id: assetId,
        _type: "sanity.fileAsset",
        assetId: sha1,
        extension: "txt",
        url: "https://cdn.sanity.io/files/project1/production/" + sha1 + ".txt",
        mimeType: "text/plain",
        size: bytes.length,
        sha1hash: sha1,
      };
      const source = validateSanityExportDocuments({
        documents: [asset, { _id: "settings", _type: "settings", file: { asset: { _ref: assetId } } }],
        projectId: "project1",
        dataset: "production",
      });
      let missingRejected = false;
      try {
        validateSanityExportDocuments({
          documents: [{ _id: "settings", _type: "settings", file: { asset: { _ref: assetId } } }],
          projectId: "project1",
          dataset: "production",
        });
      } catch {
        missingRejected = true;
      }
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), "asset-download-test-"));
      const downloaded = await downloadSanityExportAssets({
        assets: source.assets,
        directory: root,
        fetchImpl: async (url) => {
          const response = new Response(bytes, {
            status: 200,
            headers: { "content-length": String(bytes.length), "content-type": "text/plain" },
          });
          Object.defineProperty(response, "url", { value: url });
          return response;
        },
      });
      const commerce = Object.fromEntries(SNAPSHOT_ARRAYS.map((key) => [key, []]));
      commerce.format = "roo-supabase-commerce-export-v1";
      commerce.exported_at = "2026-07-15T00:00:00.000Z";
      commerce.source_documents = [{
        legacy_sanity_id: "bookingSettings",
        document_type: "bookingSettings",
        source_hash: "c".repeat(64),
        payload: { _id: "bookingSettings" },
      }];
      const validCommerce = validateCommerceExportSnapshot(commerce);
      let shallowRejected = false;
      try {
        validateCommerceExportSnapshot({
          format: commerce.format,
          exported_at: commerce.exported_at,
          source_documents: [],
        });
      } catch {
        shallowRejected = true;
      }
      process.stdout.write(JSON.stringify({
        missingRejected,
        downloaded: downloaded.length,
        byteSize: downloaded[0].byteSize,
        sourceSha1: downloaded[0].sourceSha1,
        validCommerceHash: /^[0-9a-f]{64}$/.test(validCommerce.canonicalSha256),
        shallowRejected,
        pagedDocuments: allDocuments.length,
        pageCalls,
      }));
      await fsp.rm(root, { recursive: true, force: true });
    `);
    expect(result).toMatchObject({
      missingRejected: true,
      downloaded: 1,
      byteSize: 20,
      validCommerceHash: true,
      shallowRejected: true,
      pagedDocuments: 501,
      pageCalls: 2,
    });
    expect(result.sourceSha1).toMatch(/^[0-9a-f]{40}$/);
  });

  test("requires every full logical relation and verifies canonical hashes", () => {
    const result = runModule(`
      import crypto from "node:crypto";
      import {
        stableSnapshotJson,
        SUPABASE_FULL_EXPANDED_MIGRATION_NAMES,
        SUPABASE_FULL_EXPANDED_PROFILE,
        SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS,
        SUPABASE_FULL_PRE_EXPAND_MIGRATION_VERSION,
        SUPABASE_FULL_PRE_EXPAND_PROFILE,
        SUPABASE_FULL_REQUIRED_RELATIONS,
        SUPABASE_FULL_SNAPSHOT_SCHEMAS,
        validateFullLogicalSnapshot,
      } from ${JSON.stringify(moduleUrl("src/server/tourney/snapshotContract.js"))};
      const relations = Object.fromEntries(
        SUPABASE_FULL_REQUIRED_RELATIONS.map((relation) => [
          relation,
          relation === "auth.users" ? [{ id: "user-1", email: "fixture@example.test" }] : [],
        ])
      );
      const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
      const relationPayloads = Object.fromEntries(
        Object.entries(relations).map(([relation, rows]) => [
          relation,
          relation === "auth.users"
            ? '[{"id":9007199254740993,"email":"fixture@example.test"}]'
            : stableSnapshotJson(rows),
        ])
      );
      const payload = {
        full_logical: {
          format: "roo-supabase-full-logical-snapshot-v1",
          capturedAt: "2026-07-15T00:00:00.000Z",
          sourceSnapshotId: "10000000-0000-4000-8000-000000000001",
          sourceMigrationVersion: "20260715071825",
          sourceMigrationNames: [...SUPABASE_FULL_EXPANDED_MIGRATION_NAMES],
          contractProfile: SUPABASE_FULL_EXPANDED_PROFILE,
          schemas: [...SUPABASE_FULL_SNAPSHOT_SCHEMAS],
          requiredRelations: [...SUPABASE_FULL_REQUIRED_RELATIONS],
          deferredRelations: [],
          catalogRelations: Object.keys(relationPayloads).sort(),
          catalogSha256: hash(stableSnapshotJson(Object.keys(relationPayloads).sort())),
          relationPayloads,
          relationCounts: Object.fromEntries(
            Object.entries(relations).map(([relation, rows]) => [relation, rows.length])
          ),
          relationHashes: Object.fromEntries(
            Object.entries(relationPayloads).map(([relation, rowsText]) => [
              relation,
              hash(rowsText),
            ])
          ),
        },
      };
      const proof = validateFullLogicalSnapshot(payload, { hash });
      const tampered = structuredClone(payload);
      delete tampered.full_logical.relationPayloads["commerce.bookings"];
      let missingRejected = false;
      try {
        validateFullLogicalSnapshot(tampered, { hash });
      } catch {
        missingRejected = true;
      }
      const hashTampered = structuredClone(payload);
      hashTampered.full_logical.relationHashes["auth.users"] = "0".repeat(64);
      let hashRejected = false;
      try {
        validateFullLogicalSnapshot(hashTampered, { hash });
      } catch {
        hashRejected = true;
      }
      const preExpand = structuredClone(payload);
      preExpand.full_logical.sourceMigrationVersion =
        SUPABASE_FULL_PRE_EXPAND_MIGRATION_VERSION;
      delete preExpand.full_logical.sourceMigrationNames;
      preExpand.full_logical.contractProfile = SUPABASE_FULL_PRE_EXPAND_PROFILE;
      preExpand.full_logical.requiredRelations = SUPABASE_FULL_REQUIRED_RELATIONS.filter(
        (relation) => !SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS.includes(relation)
      );
      preExpand.full_logical.deferredRelations = [
        ...SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS,
      ];
      for (const relation of SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS) {
        delete preExpand.full_logical.relationPayloads[relation];
        delete preExpand.full_logical.relationCounts[relation];
        delete preExpand.full_logical.relationHashes[relation];
      }
      preExpand.full_logical.catalogRelations = Object.keys(
        preExpand.full_logical.relationPayloads
      ).sort();
      preExpand.full_logical.catalogSha256 = hash(
        stableSnapshotJson(preExpand.full_logical.catalogRelations)
      );
      const preExpandProof = validateFullLogicalSnapshot(preExpand, { hash });
      const partialExpand = structuredClone(preExpand);
      const restoredRelation = SUPABASE_FULL_PRE_EXPAND_DEFERRED_RELATIONS[0];
      partialExpand.full_logical.relationPayloads[restoredRelation] = "[]";
      partialExpand.full_logical.relationCounts[restoredRelation] = 0;
      partialExpand.full_logical.relationHashes[restoredRelation] = hash("[]");
      partialExpand.full_logical.catalogRelations = Object.keys(
        partialExpand.full_logical.relationPayloads
      ).sort();
      partialExpand.full_logical.catalogSha256 = hash(
        stableSnapshotJson(partialExpand.full_logical.catalogRelations)
      );
      partialExpand.full_logical.requiredRelations.push(restoredRelation);
      partialExpand.full_logical.deferredRelations =
        partialExpand.full_logical.deferredRelations.filter(
          (relation) => relation !== restoredRelation
        );
      let partialExpandRejected = false;
      try {
        validateFullLogicalSnapshot(partialExpand, { hash });
      } catch {
        partialExpandRejected = true;
      }
      const unexpectedMissing = structuredClone(preExpand);
      delete unexpectedMissing.full_logical.relationPayloads["commerce.bookings"];
      delete unexpectedMissing.full_logical.relationCounts["commerce.bookings"];
      delete unexpectedMissing.full_logical.relationHashes["commerce.bookings"];
      unexpectedMissing.full_logical.catalogRelations = Object.keys(
        unexpectedMissing.full_logical.relationPayloads
      ).sort();
      unexpectedMissing.full_logical.catalogSha256 = hash(
        stableSnapshotJson(unexpectedMissing.full_logical.catalogRelations)
      );
      unexpectedMissing.full_logical.requiredRelations =
        unexpectedMissing.full_logical.requiredRelations.filter(
          (relation) => relation !== "commerce.bookings"
        );
      unexpectedMissing.full_logical.deferredRelations.push("commerce.bookings");
      let unexpectedMissingRejected = false;
      try {
        validateFullLogicalSnapshot(unexpectedMissing, { hash });
      } catch {
        unexpectedMissingRejected = true;
      }
      const oldProfile = structuredClone(preExpand);
      oldProfile.full_logical.contractProfile = SUPABASE_FULL_EXPANDED_PROFILE;
      let oldProfileRejected = false;
      try {
        validateFullLogicalSnapshot(oldProfile, { hash });
      } catch {
        oldProfileRejected = true;
      }
      const oldSnapshot = structuredClone(payload);
      delete oldSnapshot.full_logical.sourceMigrationVersion;
      delete oldSnapshot.full_logical.sourceMigrationNames;
      delete oldSnapshot.full_logical.contractProfile;
      let oldSnapshotRejected = false;
      try {
        validateFullLogicalSnapshot(oldSnapshot, { hash });
      } catch {
        oldSnapshotRejected = true;
      }
      const missingMigration = structuredClone(payload);
      missingMigration.full_logical.sourceMigrationNames =
        missingMigration.full_logical.sourceMigrationNames.slice(1);
      let missingMigrationRejected = false;
      try {
        validateFullLogicalSnapshot(missingMigration, { hash });
      } catch {
        missingMigrationRejected = true;
      }
      const countTampered = structuredClone(payload);
      countTampered.full_logical.relationCounts["auth.users"] = 2;
      let countRejected = false;
      try {
        validateFullLogicalSnapshot(countTampered, { hash });
      } catch {
        countRejected = true;
      }
      const malformed = structuredClone(payload);
      malformed.full_logical.relationPayloads["auth.users"] = "[not-json]";
      malformed.full_logical.relationHashes["auth.users"] = hash("[not-json]");
      let malformedRejected = false;
      try {
        validateFullLogicalSnapshot(malformed, { hash });
      } catch {
        malformedRejected = true;
      }
      process.stdout.write(JSON.stringify({
        relationCount: proof.relationCount,
        rowCount: proof.rowCount,
        missingRejected,
        hashRejected,
        preExpandProfile: preExpandProof.contractProfile,
        preExpandDeferred: preExpandProof.deferredRelations.length,
        partialExpandRejected,
        unexpectedMissingRejected,
        oldProfileRejected,
        oldSnapshotRejected,
        missingMigrationRejected,
        countRejected,
        malformedRejected,
        numericExact: payload.full_logical.relationPayloads["auth.users"].includes(
          "9007199254740993"
        ),
      }));
    `);
    expect(result).toEqual({
      relationCount: expect.any(Number),
      rowCount: 1,
      missingRejected: true,
      hashRejected: true,
      preExpandProfile: "roo-supabase-pre-expand-20260714230345-v1",
      preExpandDeferred: 6,
      partialExpandRejected: true,
      unexpectedMissingRejected: true,
      oldProfileRejected: true,
      oldSnapshotRejected: true,
      missingMigrationRejected: true,
      countRejected: true,
      malformedRejected: true,
      numericExact: true,
    });
    expect(result.relationCount).toBeGreaterThan(80);
  });
});
