import crypto from "node:crypto";

import {
  fetchSupabaseDatabaseTarget,
  validateDatabaseTargetTransportUrl,
} from "../../scripts/lib/supabase-database-target-transport.mjs";
import { parseTransportRepairArguments } from
  "../../scripts/tourney-live-drift-repair-via-production.mjs";
import { sealSnapshotTransportPayload } from
  "../server/tourney/snapshotTransportCrypto.js";
import { stableSnapshotJson } from "../server/tourney/snapshotContract.js";
import { readSnapshotDatabaseTarget } from "../server/tourney/snapshotTransport.js";
import migrationTargetSafety from "../server/supabase/migrationTargetSafety.cjs";

const projectRef = "ntezmxzaibrrsgtujgxu";
const databaseUrl = [
  `postgresql://postgres.${projectRef}`,
  ":fixture-value",
  "@aws-0-eu-west-1.pooler.supabase.com:5432/postgres?sslmode=require",
].join("");
const expectedTargets = {
  legacy: "a".repeat(64),
  sanity: "b".repeat(64),
  supabaseApi: "c".repeat(64),
  supabaseDatabase: "d".repeat(64),
};
const transportUrl =
  "https://www.rooindustries.com/api/admin/tourney-snapshot-transport";

const response = (value, status = 200) => {
  const bytes = Buffer.from(JSON.stringify(value));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(bytes.byteLength) },
    arrayBuffer: async () => bytes,
  };
};

describe("Supabase database target production transport", () => {
  test("keeps transport disabled unless both runtime and database gates are paused", async () => {
    const legacyDatabaseUrl = [
      "postgresql://legacy_owner",
      ":fixture-value",
      "@ep-example.eu-west-1.aws.neon.tech:5432/tourney?sslmode=require",
    ].join("");
    const supabaseUrl = `https://${projectRef}.supabase.co`;
    const sanity = { projectId: "abc123def", dataset: "production" };
    const env = {
      TOURNEY_DATABASE_TARGET_TRANSPORT_ENABLED: "  On  ",
      TOURNEY_WRITES_PAUSED: " true ",
      TOURNEY_DATABASE_MODE: "supabase",
      TOURNEY_FAILOVER_GENERATION: "1",
      TOURNEY_HARDENING_V4_ENABLED: " YeS ",
      TOURNEY_MIRROR_ENABLED: "1",
      TOURNEY_DATABASE_URL: legacyDatabaseUrl,
      SUPABASE_DATABASE_URL: databaseUrl,
      SUPABASE_URL: supabaseUrl,
      SANITY_PROJECT_ID: sanity.projectId,
      SANITY_DATASET: sanity.dataset,
    };
    const pins = {
      legacy: migrationTargetSafety.computeTourneyCutoverLegacyTargetFingerprint(
        legacyDatabaseUrl
      ),
      sanity: migrationTargetSafety.computeTourneyCutoverSanityTargetFingerprint(sanity),
      supabaseApi:
        migrationTargetSafety.computeTourneyCutoverSupabaseApiTargetFingerprint(supabaseUrl),
      supabaseDatabase:
        migrationTargetSafety.computeTourneyCutoverSupabaseDatabaseTargetFingerprint({
          databaseUrl,
          supabaseUrl,
        }),
    };
    const end = jest.fn();
    const sql = async (strings) => {
      const query = strings.join(" ");
      if (query.includes("current_database")) {
        return [{ database: "postgres", username: "postgres" }];
      }
      return [{
        primary_backend: "supabase",
        generation: 1,
        writes_paused: true,
        hardened_active: true,
      }];
    };
    sql.end = end;
    const createSqlClient = jest.fn(() => sql);
    await expect(readSnapshotDatabaseTarget({
      createSqlClient,
      env,
      expectedTargets: pins,
    })).resolves.toEqual({
      supabaseDatabaseUrl: databaseUrl,
      expectedFingerprint: pins.supabaseDatabase,
    });
    expect(end).toHaveBeenCalledWith({ timeout: 5 });
    await expect(readSnapshotDatabaseTarget({
      createSqlClient,
      env: { ...env, TOURNEY_DATABASE_TARGET_TRANSPORT_ENABLED: "0" },
      expectedTargets: pins,
    })).rejects.toMatchObject({
      code: "TOURNEY_SNAPSHOT_DATABASE_TARGET_TRANSPORT_DISABLED",
    });
    expect(createSqlClient).toHaveBeenCalledTimes(1);
  });

  test("accepts only the exact production snapshot transport route", () => {
    expect(validateDatabaseTargetTransportUrl(transportUrl)).toBe(transportUrl);
    for (const value of [
      "http://www.rooindustries.com/api/admin/tourney-snapshot-transport",
      "https://example.com/api/admin/tourney-snapshot-transport",
      "https://www.rooindustries.com/api/admin/tourney-snapshot-transport?x=1",
      "https://www.rooindustries.com/api/admin/other",
    ]) {
      expect(() => validateDatabaseTargetTransportUrl(value)).toThrow(
        expect.objectContaining({
          code: "TOURNEY_DATABASE_TARGET_TRANSPORT_URL_INVALID",
        })
      );
    }
  });

  test("returns a validated target only after request-bound decryption", async () => {
    const fetchImpl = jest.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      const object = {
        action: "database-target",
        requestId: request.requestId,
        supabaseDatabaseUrl: databaseUrl,
        expectedFingerprint: expectedTargets.supabaseDatabase,
      };
      const plaintext = Buffer.from(stableSnapshotJson(object));
      return response({
        ok: true,
        envelope: sealSnapshotTransportPayload({
          payload: plaintext,
          publicKey: request.publicKey,
          metadata: {
            requestId: request.requestId,
            payloadSha256: crypto.createHash("sha256").update(plaintext).digest("hex"),
            offset: 0,
            totalBytes: plaintext.byteLength,
            chunkBytes: plaintext.byteLength,
          },
        }),
      });
    });
    await expect(fetchSupabaseDatabaseTarget({
      bearer: "x".repeat(64),
      expectedTargets,
      fetchImpl,
      transportUrl,
    })).resolves.toEqual({
      supabaseDatabaseUrl: databaseUrl,
      expectedFingerprint: expectedTargets.supabaseDatabase,
    });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(JSON.stringify(sent)).not.toContain(databaseUrl);
    expect(sent).toMatchObject({
      action: "database-target",
      expectedTargets,
    });
  });

  test("rejects bad pins and unsealed responses", async () => {
    await expect(fetchSupabaseDatabaseTarget({
      bearer: "x".repeat(64),
      expectedTargets: { ...expectedTargets, extra: "e".repeat(64) },
      fetchImpl: jest.fn(),
      transportUrl,
    })).rejects.toMatchObject({
      code: "TOURNEY_DATABASE_TARGET_TRANSPORT_PINS_INVALID",
    });
    await expect(fetchSupabaseDatabaseTarget({
      bearer: "x".repeat(64),
      expectedTargets,
      fetchImpl: async () => response({ ok: true }),
      transportUrl,
    })).rejects.toMatchObject({
      code: "TOURNEY_DATABASE_TARGET_TRANSPORT_REJECTED",
    });
  });

  test("builds only the approved repair modes", () => {
    expect(parseTransportRepairArguments([
      "--preflight",
      "--env",
      "/private/tmp/repair.env",
      "--snapshot-transport-url",
      transportUrl,
    ])).toMatchObject({ action: "--preflight" });
    expect(() => parseTransportRepairArguments([
      "--apply",
      "--env",
      "/private/tmp/repair.env",
      "--snapshot-transport-url",
      transportUrl,
    ])).toThrow(expect.objectContaining({
      code: "TOURNEY_DATABASE_TARGET_TRANSPORT_ARGUMENT_INVALID",
    }));
    expect(() => parseTransportRepairArguments([
      "--preflight",
      "--finalize",
      "--env",
      "/private/tmp/repair.env",
      "--snapshot-transport-url",
      transportUrl,
    ])).toThrow(expect.objectContaining({
      code: "TOURNEY_DATABASE_TARGET_TRANSPORT_ACTION_INVALID",
    }));
  });
});
