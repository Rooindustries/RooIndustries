import {
  executeTourneyCommand,
  isNaturalTourneyMirrorEvent,
  readTourneyCommandId,
  resetMemoryTourneyControlForTests,
  resolveTourneyStorePolicy,
} from "../server/tourney/store";

const env = {
  NODE_ENV: "test",
  TOURNEY_DATABASE_MODE: "legacy",
  TOURNEY_MIRROR_ENABLED: "1",
  TOURNEY_FAILOVER_GENERATION: "4",
};

describe("Tourney cutover store", () => {
  beforeEach(() => resetMemoryTourneyControlForTests());

  test("replays a completed command without running its mutation twice", async () => {
    const callback = jest.fn(async () => ({ body: { ok: true, playerId: "player_1" } }));
    const command = {
      commandId: "command-registration-0001",
      purpose: "registration:create",
      requestPayload: { username: "player-one" },
      env,
      callback,
    };

    const first = await executeTourneyCommand(command);
    const replay = await executeTourneyCommand(command);

    expect(first).toMatchObject({ replayed: false, status: 200 });
    expect(replay).toMatchObject({ replayed: true, status: 200 });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("rejects reuse of a command id with a different payload", async () => {
    const base = {
      commandId: "command-registration-0002",
      purpose: "registration:create",
      env,
      callback: async () => ({ body: { ok: true } }),
    };
    await executeTourneyCommand({ ...base, requestPayload: { username: "one" } });
    await expect(
      executeTourneyCommand({ ...base, requestPayload: { username: "two" } })
    ).rejects.toMatchObject({ code: "TOURNEY_IDEMPOTENCY_CONFLICT", status: 409 });
  });

  test("pauses domain writes without changing primary selection", async () => {
    await expect(
      executeTourneyCommand({
        commandId: "command-paused-write-0001",
        purpose: "players:update-role",
        requestPayload: {},
        env: { ...env, TOURNEY_WRITES_PAUSED: "1" },
        callback: async () => ({ body: { ok: true } }),
      })
    ).rejects.toMatchObject({
      code: "TOURNEY_WRITES_PAUSED",
      status: 503,
      retryAfter: 30,
    });
  });

  test("allows an explicit private maintenance command during the pause", async () => {
    const callback = jest.fn(async () => ({ body: { ok: true } }));
    await expect(
      executeTourneyCommand({
        commandId: "command-paused-maintenance-0001",
        purpose: "accounts:seed",
        requestPayload: {},
        env: { ...env, TOURNEY_WRITES_PAUSED: "1" },
        maintenanceWhilePaused: true,
        callback,
      })
    ).resolves.toMatchObject({ status: 200, replayed: false });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  test("accepts the private identity maintenance domain", async () => {
    await expect(
      executeTourneyCommand({
        commandId: "command-identity-maintenance-0001",
        purpose: "identity:principal-seed",
        requestPayload: {},
        env,
        callback: async () => ({ body: { ok: true } }),
      })
    ).resolves.toMatchObject({ status: 200 });
  });

  test("reserves maintenance idempotency prefixes from HTTP callers", () => {
    let error;
    try {
      readTourneyCommandId({
        request: {
          headers: { get: () => "fallback-bootstrap:customer-command-0001" },
        },
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toMatchObject({
      code: "TOURNEY_IDEMPOTENCY_KEY_RESERVED",
      status: 400,
    });
  });

  test("parses the manual failover policy", () => {
    expect(resolveTourneyStorePolicy(env)).toEqual({
      primaryBackend: "legacy",
      mirrorEnabled: true,
      writesPaused: false,
      generation: 4,
    });
  });

  test("never starts the clean clock from activation maintenance events", () => {
    const base = {
      generation: 1,
      table_name: "tourney_players",
    };
    for (const commandId of [
      "fallback-bootstrap:g1:schema-v4-activation",
      "account-snapshot:seed:abc",
      "principal-seed:player:principal",
      "discord-backfill:player:user",
      "discord-state-seed:principal:g1",
      "schema-v4:activation",
      "fixture:test",
    ]) {
      expect(
        isNaturalTourneyMirrorEvent({
          sourceBackend: "supabase",
          event: { ...base, command_id: commandId },
        })
      ).toBe(false);
    }
    expect(
      isNaturalTourneyMirrorEvent({
        sourceBackend: "supabase",
        event: { ...base, command_id: "players:update:customer-command-0001" },
      })
    ).toBe(true);
  });
});
