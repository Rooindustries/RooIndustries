import crypto from "node:crypto";
import { getTourneyBracketSnapshot } from "./bracketStore.js";

export const PUBLIC_API_VERSION = "1";

export const PUBLIC_MATCH_STATUSES = Object.freeze({
  0: "locked",
  1: "waiting",
  2: "ready",
  3: "running",
  4: "completed",
  5: "archived",
  6: "cancelled",
});

const GROUP_ORDER = Object.freeze(["Winners", "Losers", "Grand Final"]);

const GROUP_KEY_ALIASES = Object.freeze({
  winners: "Winners",
  winner: "Winners",
  upper: "Winners",
  losers: "Losers",
  loser: "Losers",
  lower: "Losers",
  grandfinal: "Grand Final",
  "grand-final": "Grand Final",
  finals: "Grand Final",
  final: "Grand Final",
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export const groupKeyFromName = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";

export const normalizeGroupFilter = (value) => {
  const key = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (!key) return { ok: true, groupName: "" };
  const bare = key.replace(/-/g, "");
  const groupName = GROUP_KEY_ALIASES[key] || GROUP_KEY_ALIASES[bare];
  if (!groupName) return { ok: false, groupName: "" };
  return { ok: true, groupName };
};

export const parseStatusFilter = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return { ok: true, codes: [] };
  const codes = [];
  for (const token of raw.split(",")) {
    const entry = token.trim().toLowerCase();
    if (!entry) continue;
    if (/^\d+$/.test(entry)) {
      const code = Number(entry);
      if (!PUBLIC_MATCH_STATUSES[code]) return { ok: false, codes: [] };
      codes.push(code);
      continue;
    }
    const match = Object.entries(PUBLIC_MATCH_STATUSES).find(
      ([, slug]) => slug === entry
    );
    if (!match) return { ok: false, codes: [] };
    codes.push(Number(match[0]));
  }
  return { ok: true, codes: [...new Set(codes)] };
};

const mapPublicOpponent = (side = {}) => ({
  slot: side.side === "opponent2" ? 2 : 1,
  teamId: side.teamId || "",
  name: side.name || "TBD",
  score: side.score === "" || side.score === undefined ? null : Number(side.score),
  result: side.result || "",
  forfeit: Boolean(side.forfeit),
  winner: side.result === "win",
});

const mapPublicMatch = (match) => {
  const status = PUBLIC_MATCH_STATUSES[match.status] || "unknown";
  return {
    id: match.id,
    label: match.displayLabel || match.label,
    group: groupKeyFromName(match.groupName),
    groupName: match.groupName,
    round: match.roundNumber || 0,
    number: match.number || 0,
    status,
    statusCode: match.status,
    statusLabel: match.statusLabel || "Unknown",
    live: status === "running",
    completed: status === "completed" || status === "archived",
    bestOf: match.bestOf,
    targetScore: match.targetScore,
    opponents: [mapPublicOpponent(match.opponent1), mapPublicOpponent(match.opponent2)],
    next: Array.isArray(match.nextLabels) ? match.nextLabels : [],
  };
};

const buildContentVersion = ({ generated, teams, matches }) =>
  crypto
    .createHash("sha1")
    .update(JSON.stringify({ generated, teams, matches }))
    .digest("hex")
    .slice(0, 16);

const buildGroups = (matches) =>
  GROUP_ORDER.map((groupName) => {
    const groupMatches = matches.filter((match) => match.groupName === groupName);
    if (groupMatches.length === 0) return null;
    const roundNumbers = [...new Set(groupMatches.map((match) => match.round))].sort(
      (left, right) => left - right
    );
    const rounds = roundNumbers.map((round) => ({
      number: round,
      matches: groupMatches
        .filter((match) => match.round === round)
        .sort((left, right) => left.number - right.number),
    }));
    return { key: groupKeyFromName(groupName), name: groupName, rounds };
  }).filter(Boolean);

const baseEnvelope = (snapshot, matches) => ({
  ok: true,
  apiVersion: PUBLIC_API_VERSION,
  version: buildContentVersion({
    generated: Boolean(snapshot?.generated),
    teams: snapshot?.teams || [],
    matches,
  }),
  updatedAt: snapshot?.meta?.updatedAt || "",
  generated: Boolean(snapshot?.generated),
  published: Boolean(snapshot?.meta?.published),
});

export const buildPublicBracketResponse = (snapshot) => {
  const matches = (snapshot?.matches || []).map(mapPublicMatch);
  return {
    ...baseEnvelope(snapshot, matches),
    teams: (snapshot?.teams || []).map((team) => ({
      id: team.id,
      name: team.name,
      seed: team.seed ?? null,
      status: team.status || "active",
    })),
    groups: buildGroups(matches),
    matches,
  };
};

export const buildPublicMatchesResponse = (
  snapshot,
  { statusCodes = [], groupName = "" } = {}
) => {
  const matches = (snapshot?.matches || [])
    .map(mapPublicMatch)
    .filter((match) =>
      statusCodes.length > 0 ? statusCodes.includes(match.statusCode) : true
    )
    .filter((match) => (groupName ? match.groupName === groupName : true));
  return {
    ...baseEnvelope(snapshot, matches),
    count: matches.length,
    matches,
  };
};

const compareFeedMatches = (left, right) => {
  const leftGroup = GROUP_ORDER.indexOf(left.groupName);
  const rightGroup = GROUP_ORDER.indexOf(right.groupName);
  if (leftGroup !== rightGroup) return leftGroup - rightGroup;
  if (left.round !== right.round) return left.round - right.round;
  return left.number - right.number;
};

export const buildPublicLiveResponse = (snapshot, { limit = 3 } = {}) => {
  const boundedLimit = clamp(Number(limit) || 3, 1, 10);
  const matches = (snapshot?.matches || []).map(mapPublicMatch);
  const live = matches
    .filter((match) => match.status === "running")
    .sort(compareFeedMatches);
  const upNext = matches
    .filter((match) => match.status === "ready")
    .sort(compareFeedMatches)
    .slice(0, boundedLimit);
  return {
    ...baseEnvelope(snapshot, matches),
    live,
    upNext,
  };
};

export const readPublicBracketApiSnapshot = ({ env = process.env } = {}) =>
  env === process.env
    ? getTourneyBracketSnapshot()
    : getTourneyBracketSnapshot({ env });
