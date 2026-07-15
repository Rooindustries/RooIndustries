import {
  listTourneyAppealsForSession,
  listTourneyPayoutsForSession,
} from "./appealPayoutStore.js";
import { getTourneyBracketSnapshot } from "./bracketStore.js";
import {
  getManageTourneyPlayersSnapshot,
  listApprovedTourneyPlayers,
} from "./playerStore.js";

const shadowAdmin = Object.freeze({ username: "shadow-verifier", role: "owner" });

export const readPublicTourneyRoster = async ({ env = process.env } = {}) => ({
  ok: true,
  players: await (env === process.env
    ? listApprovedTourneyPlayers()
    : listApprovedTourneyPlayers({ env })),
});

export const readPublicTourneyBracket = ({ env = process.env } = {}) =>
  env === process.env
    ? getTourneyBracketSnapshot()
    : getTourneyBracketSnapshot({ env });

export const readAdminTourneyPlayers = async ({ env = process.env } = {}) => {
  const { players, capacity } = await (env === process.env
    ? getManageTourneyPlayersSnapshot()
    : getManageTourneyPlayersSnapshot({ env }));
  return { ok: true, players, capacity };
};

export const readTourneyAppeals = async ({ session, env = process.env } = {}) => ({
  ok: true,
  appeals: await listTourneyAppealsForSession(
    env === process.env ? { session } : { session, env }
  ),
});

export const readTourneyPayouts = async ({ session, env = process.env } = {}) => ({
  ok: true,
  payouts: await listTourneyPayoutsForSession(
    env === process.env ? { session } : { session, env }
  ),
});

export const TOURNEY_READ_SERVICES = Object.freeze({
  public_roster: ({ env }) => readPublicTourneyRoster({ env }),
  public_bracket: ({ env }) => readPublicTourneyBracket({ env }),
  admin_players: ({ env }) => readAdminTourneyPlayers({ env }),
  appeals: ({ env }) => readTourneyAppeals({ session: shadowAdmin, env }),
  payouts: ({ env }) => readTourneyPayouts({ session: shadowAdmin, env }),
});

export const readTourneyService = async ({ route, env = process.env } = {}) => {
  const service = TOURNEY_READ_SERVICES[route];
  if (!service) throw new Error("Unsupported Tourney read service.");
  const startedAt = performance.now();
  try {
    const body = await service({ env });
    return {
      status: 200,
      errorCode: "",
      body,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  } catch (error) {
    return {
      status: Number(error?.status || 500),
      errorCode: String(error?.code || "TOURNEY_READ_FAILED").slice(0, 128),
      body: null,
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
  }
};
