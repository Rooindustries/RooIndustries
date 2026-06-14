export const isTourneyAdminSession = (session = null) =>
  session?.role === "owner" || session?.role === "caster";

export const canAccessTourneyRegistration = (session = null) =>
  !session || isTourneyAdminSession(session);

const normalizeAccessUsername = (value) =>
  String(value || "").trim().toLowerCase();

export const isMatchingTourneyApproverSession = ({
  session = null,
  approver = null,
} = {}) =>
  isTourneyAdminSession(session) &&
  isTourneyAdminSession(approver) &&
  normalizeAccessUsername(session?.username) ===
    normalizeAccessUsername(approver?.username) &&
  session?.role === approver?.role;
