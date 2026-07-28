const OPPONENT_KEYS = ["opponent1", "opponent2"];

const GROUP_NUMBERS = Object.freeze({
  Winners: 1,
  Losers: 2,
  "Grand Final": 3,
});

const toInternalSide = (opponent, index) => ({
  side: OPPONENT_KEYS[index],
  participantId: null,
  teamId: opponent?.teamId || "",
  name: opponent?.name || "TBD",
  score: opponent?.score ?? "",
  result: opponent?.result || "",
  forfeit: Boolean(opponent?.forfeit),
  status: "",
});

const toInternalMatch = (match) => ({
  id: match.id,
  number: match.number,
  roundNumber: match.round,
  groupNumber: GROUP_NUMBERS[match.groupName] || 0,
  groupName: match.groupName,
  label: match.label,
  displayLabel: match.label,
  status: match.statusCode,
  statusLabel: match.statusLabel,
  bestOf: match.bestOf,
  targetScore: match.targetScore,
  opponent1: toInternalSide(match.opponents?.[0], 0),
  opponent2: toInternalSide(match.opponents?.[1], 1),
  nextLabels: Array.isArray(match.next) ? match.next : [],
});

export const toInternalSnapshot = (payload) => ({
  ok: Boolean(payload?.ok),
  generated: Boolean(payload?.generated),
  matches: (payload?.matches || []).map(toInternalMatch),
});
