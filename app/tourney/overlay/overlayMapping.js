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

// On stream, only matches that need viewer attention get a status pill.
// Finished brackets read from the winner/loser highlighting alone, so
// Locked/Waiting/Completed/Archived all render without a pill.
const OVERLAY_STATUS_LABELS = Object.freeze({
  running: "LIVE",
  ready: "Up Next",
  "game cancelled": "Cancelled",
});

const toOverlayStatusLabel = (match) => {
  const key = String(match?.statusLabel || match?.status || "")
    .trim()
    .toLowerCase();
  return OVERLAY_STATUS_LABELS[key] || "";
};

const toInternalMatch = (match) => ({
  id: match.id,
  number: match.number,
  roundNumber: match.round,
  groupNumber: GROUP_NUMBERS[match.groupName] || 0,
  groupName: match.groupName,
  label: match.label,
  displayLabel: match.label,
  status: match.statusCode,
  statusLabel: toOverlayStatusLabel(match),
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
