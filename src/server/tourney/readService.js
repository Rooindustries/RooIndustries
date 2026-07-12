import {
  listTourneyAppealsForSession,
  listTourneyPayoutsForSession,
} from "./appealPayoutStore.js";
import { getTourneyBracketSnapshot } from "./bracketStore.js";
import {
  getTourneyRoleCapacitySnapshot,
  listApprovedTourneyPlayers,
  listManageTourneyPlayers,
} from "./playerStore.js";

const shadowAdmin = Object.freeze({ username: "shadow-verifier", role: "owner" });

export const TOURNEY_READ_SERVICES = Object.freeze({
  public_roster: ({ env }) => listApprovedTourneyPlayers({ env })
    .then((players) => ({ ok: true, players })),
  public_bracket: ({ env }) => getTourneyBracketSnapshot({ env }),
  admin_players: async ({ env }) => ({
    ok: true,
    players: await listManageTourneyPlayers({ env }),
    capacity: await getTourneyRoleCapacitySnapshot({ env }),
  }),
  appeals: ({ env }) => listTourneyAppealsForSession({ session: shadowAdmin, env })
    .then((appeals) => ({ ok: true, appeals })),
  payouts: ({ env }) => listTourneyPayoutsForSession({ session: shadowAdmin, env })
    .then((payouts) => ({ ok: true, payouts })),
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
