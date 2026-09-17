import { getReferralSession } from "../api/ref/auth.js";

import { resolveSupabaseAccountByUserId } from "./accounts.js";
import { getNextSupabaseUser } from "./serverSession.js";

const cookieHeader = (request) => request.headers.get("cookie") || "";



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



  return null;
};
