import { getReferralSession } from "../api/ref/auth.js";
import {
  TOURNEY_SESSION_COOKIE,
  readTourneySessionFromStore,
} from "../tourney/auth.js";
import { resolveSupabaseAccountByUserId } from "./accounts.js";
import { getNextSupabaseUser } from "./serverSession.js";

const cookieHeader = (request) => request.headers.get("cookie") || "";

const cookieValue = (request, name) => {
  const structured = request.cookies?.get?.(name)?.value;
  if (structured) return structured;
  const match = cookieHeader(request)
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  if (!match) return "";
  const raw = match.slice(name.length + 1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const resolveExactDomainIdentity = async ({
  flow,
  request,
  response,
  user: verifiedUser,
} = {}) => {
  const user = verifiedUser?.id
    ? verifiedUser
    : await getNextSupabaseUser({ request, response });
  if (!user?.id) return null;

  if (flow === "referral") {
    const session = getReferralSession({
      headers: { cookie: cookieHeader(request) },
    });
    if (!session) return null;
    const account = await resolveSupabaseAccountByUserId({ userId: user.id });
    if (
      !account ||
      !account.principal_id ||
      (session.principalId && account.principal_id !== session.principalId) ||
      Number(account.session_version || 1) !== Number(session.sessionVersion || 1) ||
      account.status !== "active" ||
      !(account.roles || []).includes("creator") ||
      account.creator_active === false ||
      account.creator_legacy_sanity_id !== session.referralId ||
      account.referral_code !== session.code
    ) {
      return null;
    }
    return {
      account,
      domainSubject: session.referralId,
      user,
    };
  }

  if (flow === "tourney") {
    const session = await readTourneySessionFromStore({
      token: cookieValue(request, TOURNEY_SESSION_COOKIE),
    });
    if (!session) return null;
    const account = await resolveSupabaseAccountByUserId({ userId: user.id });
    const role = String(account?.tourney_role || "").replace(/^tourney_/, "");
    if (
      !account ||
      account.status !== "active" ||
      account.tourney_active === false ||
      account.tourney_username !== session.username ||
      role !== session.role
    ) {
      return null;
    }
    return {
      account,
      domainSubject: session.username,
      user,
    };
  }

  return null;
};
