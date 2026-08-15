export const isTourneyAdminSession = (session = null) =>
  session?.role === "owner" || session?.role === "caster";

export const canAccessTourneyRegistration = (session = null) =>
  !session || isTourneyAdminSession(session);

export const canAccessTourneyManage = (session = null) =>
  session?.role === "owner";

const normalizeAccessUsername = (value) =>
  String(value || "").trim().toLowerCase();

const TOURNEY_CASTER_IDS_BY_USERNAME = Object.freeze({
  yukari: Object.freeze([1]),
  spankycheeze: Object.freeze([1]),
  supa: Object.freeze([2]),
  gmr: Object.freeze([3]),
  kimchibapbop: Object.freeze([4]),
  lightow: Object.freeze([5]),
  lemon: Object.freeze([6]),
  ace: Object.freeze([7]),
});

export const getTourneyCasterIds = (session = null) =>
  session?.role === "caster"
    ? TOURNEY_CASTER_IDS_BY_USERNAME[
        normalizeAccessUsername(session?.username)
      ] || []
    : [];

export const canManageTourneyMatch = ({ session = null, match = null } = {}) => {
  if (session?.role === "owner") return true;
  if (session?.role !== "caster") return false;

  const username = normalizeAccessUsername(session?.username);
  const casterIds = getTourneyCasterIds(session);
  const assignedIds = Array.isArray(match?.schedule?.casterIds)
    ? match.schedule.casterIds.map(Number)
    : [];
  if (!assignedIds.some((id) => casterIds.includes(id))) return false;

  if (username === "spankycheeze" && assignedIds.includes(1)) {
    return (match?.casters || []).some(
      (caster) =>
        Number(caster?.id) === 1 &&
        normalizeAccessUsername(caster?.label).includes("spankycheeze")
    );
  }

  return true;
};

export const isMatchingTourneyApproverSession = ({
  session = null,
  approver = null,
} = {}) =>
  isTourneyAdminSession(session) &&
  isTourneyAdminSession(approver) &&
  normalizeAccessUsername(session?.username) ===
    normalizeAccessUsername(approver?.username) &&
  session?.role === approver?.role;
