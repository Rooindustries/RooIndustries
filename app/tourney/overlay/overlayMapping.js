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
  // The raw status slug ("running", "completed", ...) for the card status
  // class: the overlay-mapped statusLabel only covers LIVE/Up Next/Cancelled,
  // so without this the LIVE glow and completed dimming could never fire.
  statusSlug: typeof match?.status === "string" ? match.status : "",
  bestOf: match.bestOf,
  targetScore: match.targetScore,
  publicMatchNumber: match.publicMatchNumber ?? null,
  schedule: match.schedule || null,
  casters: Array.isArray(match.casters) ? match.casters : [],
  slotLabels: match.slotLabels || {},
  autoAdvance: Boolean(match.autoAdvance),
  opponent1: toInternalSide(match.opponents?.[0], 0),
  opponent2: toInternalSide(match.opponents?.[1], 1),
  nextLabels: Array.isArray(match.next) ? match.next : [],
});

export const toInternalSnapshot = (payload) => ({
  ok: Boolean(payload?.ok),
  generated: Boolean(payload?.generated),
  matches: (payload?.matches || []).map(toInternalMatch),
});

export const OVERLAY_GROUP_FILTERS = Object.freeze({
  winners: "Winners",
  losers: "Losers",
  "grand-final": "Grand Final",
});

// Lane sources (?group=) must filter even before the bracket is generated,
// when the API has no matches and the view renders its TBD skeleton — so the
// caller passes that skeleton in and we filter it like a real bracket.
export const filterSnapshotByGroup = (
  internal,
  group,
  skeletonMatches = []
) => {
  const groupName = OVERLAY_GROUP_FILTERS[group];
  if (!groupName || !internal) return internal;
  const base = internal.generated
    ? internal.matches || []
    : internal.matches?.length
      ? internal.matches
      : skeletonMatches;
  return {
    ...internal,
    matches: base.filter((match) => match.groupName === groupName),
  };
};
