import fs from "node:fs";
import path from "node:path";
import {
  isTourneyPlayerAuthStateCurrent,
  resolveTourneyDiscordOperationAccessToken,
} from "../server/tourney/externalOperations";
import {
  desiredTourneyDiscordRoleForAccount,
  normalizeTourneyDiscordState,
} from "../server/tourney/discordDesiredState";

const migration = fs.readFileSync(
  path.join(
    process.cwd(),
    "supabase",
    "migrations",
    "20260714000000_harden_tourney_external_authority.sql"
  ),
  "utf8"
);

describe("Tourney durable external operation authority", () => {
  test("recovers a Discord credential from durable storage after request context is lost", async () => {
    const readSecret = jest.fn().mockResolvedValue("durable-discord-token");
    const operation = { entity_id: "player-1", operation_key: "discord-operation-1" };
    await expect(resolveTourneyDiscordOperationAccessToken({
      context: {},
      operation,
      readSecret,
    })).resolves.toBe("durable-discord-token");
    expect(readSecret).toHaveBeenCalledWith({ operation, env: process.env });
  });

  test("uses the in-request Discord credential without reading storage", async () => {
    const readSecret = jest.fn();
    await expect(resolveTourneyDiscordOperationAccessToken({
      context: { discordAccessTokens: { "player-1": "request-token" } },
      operation: { entity_id: "player-1", operation_key: "discord-operation-1" },
      readSecret,
    })).resolves.toBe("request-token");
    expect(readSecret).not.toHaveBeenCalled();
  });

  test("rejects a stale player Auth snapshot before provider work", () => {
    expect(isTourneyPlayerAuthStateCurrent({
      current: { id: "player-1", status: "removed", version: 4 },
      desired: { id: "player-1", status: "approved", version: 3 },
    })).toBe(false);
    expect(isTourneyPlayerAuthStateCurrent({
      current: { id: "player-1", status: "approved", version: 4 },
      desired: { id: "player-1", status: "approved", version: 4 },
    })).toBe(true);
  });

  test("normalizes only durable role application as success", () => {
    expect(normalizeTourneyDiscordState("applied", true)).toBe("applied");
    expect(normalizeTourneyDiscordState("processing", true)).toBe("pending");
    expect(normalizeTourneyDiscordState("retry", true)).toBe("retry");
    expect(normalizeTourneyDiscordState("blocked", true)).toBe("blocked_reauth");
    expect(normalizeTourneyDiscordState("blocked_reauth", true)).toBe("blocked_reauth");
    expect(normalizeTourneyDiscordState("dead_letter", true)).toBe("dead_letter");
    expect(normalizeTourneyDiscordState("pending", false)).toBe("unlinked");
    expect(normalizeTourneyDiscordState("retry", false)).toBe("unlinked");
  });

  test("maps inactive and viewer accounts to managed-role removal", () => {
    expect(desiredTourneyDiscordRoleForAccount({
      active: true,
      lifecycle_status: "approved",
      role: "tourney_viewer",
    })).toBe("none");
    expect(desiredTourneyDiscordRoleForAccount({
      active: false,
      lifecycle_status: "disabled",
      role: "tourney_caster",
    })).toBe("none");
    expect(desiredTourneyDiscordRoleForAccount({
      active: true,
      lifecycle_status: "approved",
      role: "tourney_player",
    })).toBe("participant");
  });

  test("installs monotonic account import and preserves blocked reauthorization", () => {
    expect(migration).toContain("v_existing.credential_version::bigint > v_version");
    expect(migration).toContain("v_existing.source_hash is distinct from v_source_hash");
    expect(migration).toContain("'stale', true");
    expect(migration).toContain("player_id = excluded.player_id");
    expect(migration).toContain("then accounts.discord_role_assignments.status");
    expect(migration).toContain("then 'blocked_reauth'");
    expect(migration).toContain("'dead_letter','blocked','blocked_reauth'");
  });
});
