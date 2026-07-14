import crypto from "node:crypto";
import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../../../../../src/server/tourney/auth";
import { getTourneyDiscordOAuthConfig } from "../../../../../src/server/tourney/discordConfig";
import {
  listTourneyDiscordDesiredState,
  recordTourneyDiscordDesiredState,
} from "../../../../../src/server/tourney/discordDesiredState";
import { enqueueTourneyExternalOperation } from "../../../../../src/server/tourney/externalOperations";
import { listManageTourneyPlayers } from "../../../../../src/server/tourney/playerStore";
import { executeTourneyCommand } from "../../../../../src/server/tourney/store";
import { getTourneySqlForBackend } from "../../../../../src/server/tourney/sqlClient";
import { isSameOriginMutation } from "../../../../../src/server/request/sameOrigin";
import { logSafeError } from "../../../../../src/server/safeErrorLog";
import { buildTourneyPublicError } from "../../../../../src/server/tourney/publicError";
import { readBoundedJson } from "../../../../../src/server/request/boundedJson";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const jsonError = (message, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

const getAdminSession = async (request) => {
  const token = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
  const session = await readTourneySessionFromStore({ token });
  return session && ["owner", "caster"].includes(session.role) ? session : null;
};

const readMember = async ({ discordUserId, config, fetchImpl = fetch }) => {
  try {
    const response = await fetchImpl(
      `${config.apiBaseUrl}/guilds/${config.guildId}/members/${discordUserId}`,
      {
        headers: { Authorization: `Bot ${config.botToken}` },
        signal: AbortSignal.timeout(5_000),
      }
    );
    if (response.status === 404) return { membership: "absent", managedRoles: [] };
    if (!response.ok) {
      return { membership: "unknown", managedRoles: [], errorCode: `discord_http_${response.status}` };
    }
    const member = await response.json();
    const roles = new Set(Array.isArray(member.roles) ? member.roles.map(String) : []);
    return {
      membership: "present",
      managedRoles: [
        ...(roles.has(config.participantRoleId) ? ["participant"] : []),
        ...(roles.has(config.hostRoleId) ? ["host"] : []),
      ],
    };
  } catch (error) {
    return {
      membership: "unknown",
      managedRoles: [],
      errorCode: error?.name === "TimeoutError" ? "discord_timeout" : "discord_unavailable",
    };
  }
};

const resolveAuthoritativeDiscordPlayers = async ({ players, env = process.env }) => {
  const sql = await getTourneySqlForBackend({ backend: "supabase", env });
  const mappings = await sql`
    select account.legacy_sanity_id as player_id,
      account.principal_id,
      account.active as account_active,
      identity.provider_subject as discord_user_id
    from accounts.tourney_accounts account
    left join accounts.identity_links identity
      on identity.principal_id = account.principal_id
     and identity.provider = 'discord'
    where account.role = 'tourney_player'
      and account.legacy_sanity_id is not null
    order by account.legacy_sanity_id
  `;
  const mappingsByPlayer = new Map();
  for (const mapping of mappings) {
    const playerId = String(mapping.player_id || "").trim();
    if (!playerId) continue;
    const existing = mappingsByPlayer.get(playerId) || [];
    existing.push(mapping);
    mappingsByPlayer.set(playerId, existing);
  }
  return players.flatMap((player) => {
    const candidates = mappingsByPlayer.get(player.id) || [];
    const mapping = candidates.length === 1 ? candidates[0] : null;
    const legacyDiscordUserId = String(player.discordUserId || "").trim();
    const authoritativeDiscordUserId = String(mapping?.discord_user_id || "").trim();
    if (!legacyDiscordUserId && !authoritativeDiscordUserId) return [];
    const conflictCode = candidates.length > 1
      ? "duplicate_principal_mapping"
      : !mapping?.principal_id
        ? "missing_principal"
        : mapping.account_active !== true
          ? "inactive_tourney_account"
        : !authoritativeDiscordUserId
          ? "missing_authoritative_identity"
          : legacyDiscordUserId && legacyDiscordUserId !== authoritativeDiscordUserId
            ? "legacy_identity_mismatch"
            : "";
    return [{
      player,
      playerId: player.id,
      principalId: String(mapping?.principal_id || ""),
      legacyDiscordUserId,
      authoritativeDiscordUserId,
      conflictCode,
      verified: Boolean(
        candidates.length === 1 && mapping?.principal_id &&
        mapping.account_active === true && authoritativeDiscordUserId
      ),
    }];
  });
};

const mapInBatches = async (items, callback, batchSize = 5) => {
  const results = [];
  for (let offset = 0; offset < items.length; offset += batchSize) {
    results.push(...await Promise.all(items.slice(offset, offset + batchSize).map(callback)));
  }
  return results;
};

const inventory = async ({ config }) => {
  const [players, assignments] = await Promise.all([
    listManageTourneyPlayers(),
    listTourneyDiscordDesiredState().catch(() => []),
  ]);
  const assignmentByPlayer = new Map(
    assignments.map((assignment) => [assignment.player_id, assignment])
  );
  const approved = players.filter((player) => player.status === "approved");
  const resolved = await resolveAuthoritativeDiscordPlayers({ players: approved });
  const rows = await mapInBatches(resolved, async (entry) => {
    const current = entry.verified
      ? await readMember({ discordUserId: entry.authoritativeDiscordUserId, config })
      : { membership: "not_checked", managedRoles: [] };
    const desiredRole = "participant";
    return {
      playerId: entry.playerId,
      legacyDiscordUserId: entry.legacyDiscordUserId,
      discordUserId: entry.authoritativeDiscordUserId,
      principalMapped: Boolean(entry.principalId),
      authoritativeIdentityLinked: Boolean(entry.authoritativeDiscordUserId),
      membership: current.membership,
      desiredRole,
      currentManagedRoles: current.managedRoles,
      conflictCode: entry.conflictCode || undefined,
      conflict: Boolean(entry.conflictCode) || current.managedRoles.length > 1,
      needsRepair:
        entry.verified &&
        current.membership === "present" &&
        (current.managedRoles.length !== 1 || current.managedRoles[0] !== desiredRole),
      desiredStatePresent: Boolean(assignmentByPlayer.get(entry.playerId)),
      ...(current.errorCode ? { errorCode: current.errorCode } : {}),
    };
  });
  return {
    rows,
    counts: {
      linked: rows.length,
      present: rows.filter((row) => row.membership === "present").length,
      blockedReauth: rows.filter((row) => row.membership === "absent").length,
      conflicts: rows.filter((row) => row.conflict).length,
      missingAuthority: rows.filter((row) =>
        ["missing_principal", "missing_authoritative_identity"].includes(row.conflictCode)
      ).length,
      identityMismatches: rows.filter((row) =>
        row.conflictCode === "legacy_identity_mismatch"
      ).length,
      needsRepair: rows.filter((row) => row.needsRepair).length,
    },
  };
};

export async function GET(request) {
  const session = await getAdminSession(request);
  if (!session) return jsonError("Not found.", 404);
  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) return jsonError("Discord OAuth is not configured.", 503);
  try {
    return NextResponse.json({ ok: true, dryRun: true, ...(await inventory({ config })) });
  } catch (error) {
    logSafeError("Tourney Discord inventory failed", error);
    return jsonError("Discord inventory is temporarily unavailable.", 503);
  }
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) return jsonError("Cross-origin request rejected.", 403);
  const session = await getAdminSession(request);
  if (!session) return jsonError("Not found.", 404);
  const config = getTourneyDiscordOAuthConfig({ baseUrl: request.url });
  if (!config.enabled) return jsonError("Discord OAuth is not configured.", 503);
  let payload;
  try {
    payload = await readBoundedJson(request, { maxBytes: 4 * 1024 });
  } catch (error) {
    return jsonError(error?.message || "Invalid Discord inventory request.", Number(error?.status || 400));
  }
  if (String(payload.action || "dry-run").toLowerCase() !== "apply") {
    try {
      return NextResponse.json({ ok: true, dryRun: true, ...(await inventory({ config })) });
    } catch (error) {
      logSafeError("Tourney Discord inventory failed", error);
      return jsonError("Discord inventory is temporarily unavailable.", 503);
    }
  }

  let resolved;
  try {
    const players = (await listManageTourneyPlayers()).filter(
      (player) => player.status === "approved"
    );
    resolved = await resolveAuthoritativeDiscordPlayers({ players });
  } catch (error) {
    logSafeError("Tourney Discord apply inventory failed", error);
    return jsonError("Discord desired-state inventory is temporarily unavailable.", 503);
  }
  let queued = 0;
  const failures = [];
  const repairId = crypto.randomUUID();
  const conflicts = resolved.filter((entry) => !entry.verified).map((entry) => ({
    playerId: entry.playerId,
    code: entry.conflictCode,
  }));
  const verifiedMismatches = resolved.filter((entry) =>
    entry.verified && entry.conflictCode === "legacy_identity_mismatch"
  );
  for (const entry of resolved.filter((candidate) => candidate.verified)) {
    const player = { ...entry.player, discordUserId: entry.authoritativeDiscordUserId };
    const commandId = `discord-backfill:${repairId}:${player.id}`;
    try {
      await executeTourneyCommand({
        commandId,
        purpose: "discord:backfill",
        requestPayload: {
          repairId,
          playerId: player.id,
          discordUserId: entry.authoritativeDiscordUserId,
          forceRepair: true,
        },
        attemptExternalWork: false,
        callback: async () => {
          const assignment = await recordTourneyDiscordDesiredState({
            player,
            discordUser: { id: player.discordUserId },
            guildId: config.guildId,
            forceRepair: true,
          });
          await enqueueTourneyExternalOperation({
            commandId,
            operationKind: "discord_role_reconcile",
            entityType: "player",
            entityId: player.id,
            desiredState: {
              assignment: {
                principalId: assignment.principal_id || assignment.principalId,
                discordUserId: assignment.discord_user_id || assignment.discordUserId,
                previousDiscordUserId:
                  assignment.previous_discord_user_id || assignment.previousDiscordUserId || "",
                staleDiscordUserIds:
                  assignment.stale_discord_user_ids || assignment.staleDiscordUserIds || [],
                desiredRole: assignment.desired_role || assignment.desiredRole,
                generation: Number(assignment.generation || 1),
              },
            },
          });
          return { body: { ok: true } };
        },
      });
      queued += 1;
    } catch (error) {
      if (error?.code === "TOURNEY_WRITES_PAUSED") {
        const failure = buildTourneyPublicError(
          error,
          "Tournament updates are temporarily unavailable."
        );
        return NextResponse.json(
          { ok: false, error: failure.message, code: failure.code },
          {
            status: failure.status,
            headers: { "Retry-After": String(error.retryAfter || 30) },
          }
        );
      }
      const failure = buildTourneyPublicError(
        error,
        "Unable to queue Discord role synchronization."
      );
      failures.push({
        playerId: player.id,
        status: failure.status,
        code: failure.code || "TOURNEY_DISCORD_ENQUEUE_FAILED",
      });
    }
  }
  return NextResponse.json({
    ok: failures.length === 0 && conflicts.length === 0,
    dryRun: false,
    queued,
    failed: failures.length,
    skippedConflicts: conflicts.length,
    identityMismatchesQueued: verifiedMismatches.length,
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(failures.length > 0 ? { failures } : {}),
    contactedDiscord: false,
  });
}
