import { NextResponse } from "next/server";
import { resolveSupabaseAccountByUserId } from "../../../../src/server/supabase/accounts";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient";
import { resolveExactDomainIdentity } from "../../../../src/server/supabase/domainIdentity";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import {
  clearReauthCookie,
  hashReauthToken,
  readReauthToken,
} from "../../../../src/server/supabase/reauth";
import {
  createNextSupabaseSessionClient,
  getNextSupabaseUser,
} from "../../../../src/server/supabase/serverSession";
import { queueTourneyDiscordIdentityUnlinkProjection } from "../../../../src/server/tourney/discordDesiredState";
import { isSupabaseTourneyDatabase } from "../../../../src/server/tourney/sqlClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedFlows = new Set(["referral", "tourney"]);
const allProviders = new Set(["google", "discord"]);

const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

const jsonFrom = (source, payload, status = 200) => {
  const response = NextResponse.json(payload, { status });
  for (const cookie of source?.cookies?.getAll?.() || []) {
    response.cookies.set(cookie);
  }
  return noStore(response);
};

const hasFlowRole = (account, flow) => {
  if (!account || account.status !== "active") return false;
  if (flow === "referral") {
    return (account.roles || []).includes("creator") && account.creator_active !== false;
  }
  return Boolean(
    account.tourney_username &&
      account.tourney_role &&
      account.tourney_active !== false
  );
};

export async function GET(request) {
  const flow = String(new URL(request.url).searchParams.get("flow") || "")
    .trim()
    .toLowerCase();
  if (!allowedFlows.has(flow)) {
    return noStore(
      NextResponse.json(
        { ok: false, error: "Account type is invalid." },
        { status: 400 }
      )
    );
  }

  const response = NextResponse.json({ ok: true, authenticated: false });
  try {
    const user = await getNextSupabaseUser({ request, response });
    if (!user?.id) return noStore(response);
    const account = await resolveSupabaseAccountByUserId({ userId: user.id });
    const sessionProviders = [...new Set(
      (user.identities || [])
        .map((identity) => String(identity?.provider || "").toLowerCase())
        .filter((provider) => ["email", "google", "discord"].includes(provider))
    )].sort();
    const providers = [...new Set(
      [...(account?.connected_providers || []), ...sessionProviders]
        .map((provider) => String(provider || "").toLowerCase())
        .filter((provider) => ["email", "google", "discord"].includes(provider))
    )].sort();
    return jsonFrom(response, {
        ok: true,
        authenticated: true,
        email: String(account?.verified_real_email || ""),
        emailVerified: Boolean(account?.verified_real_email),
        providers,
        unlinkableProviders: sessionProviders,
        domainAccount: hasFlowRole(account, flow),
      });
  } catch {
    return jsonFrom(
      response,
      { ok: false, error: "Account connections are temporarily unavailable." },
      503
    );
  }
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return noStore(NextResponse.json({ ok: false, error: "Cross-origin request rejected." }, { status: 403 }));
  }
  let payload;
  try {
    payload = await readBoundedJson(request);
  } catch (error) {
    return noStore(NextResponse.json({ ok: false, error: error.message }, { status: Number(error.status || 400) }));
  }
  const provider = String(payload.provider || "").trim().toLowerCase();
  const flow = String(payload.flow || "").trim().toLowerCase();
  if (!allowedFlows.has(flow)) {
    return noStore(NextResponse.json({ ok: false, error: "Account type is invalid." }, { status: 400 }));
  }
  if (!allProviders.has(provider)) {
    return noStore(NextResponse.json({ ok: false, error: "Provider is invalid." }, { status: 400 }));
  }
  const response = NextResponse.json({ ok: true });
  try {
    const client = createNextSupabaseSessionClient({ request, response });
    const userResult = await client.auth.getUser();
    if (userResult.error || !userResult.data?.user?.id) {
      return jsonFrom(response, { ok: false, error: "Sign in again before unlinking an account." }, 401);
    }
    const sessionResult = await client.auth.getSession();
    const domainIdentity = await resolveExactDomainIdentity({
      flow,
      request,
      response,
      user: userResult.data.user,
    });
    const user = domainIdentity?.user;
    const account = domainIdentity?.account;
    const session = sessionResult.data?.session;
    if (sessionResult.error || !user?.id || !account || !session?.access_token) {
      return jsonFrom(response, { ok: false, error: "Sign in again before unlinking an account." }, 401);
    }
    const identity = (user.identities || []).find(
      (candidate) => String(candidate?.provider || "").toLowerCase() === provider
    );
    if (identity && (user.identities || []).length < 2) {
      return jsonFrom(response, { ok: false, error: "Keep at least one sign-in method connected." }, 409);
    }
    const reauthToken = readReauthToken(request);
    if (!reauthToken) {
      return jsonFrom(response, { ok: false, error: "Reauthenticate before unlinking a provider.", reauthRequired: true }, 409);
    }
    const tokenHash = hashReauthToken(reauthToken);
    const admin = createSupabaseAdminClient();
    const referralOnly = flow === "referral" && !hasFlowRole(account, "tourney");
    if (!referralOnly && !isSupabaseTourneyDatabase(process.env)) {
      return jsonFrom(response, {
        ok: false,
        error: "Connected-account changes are temporarily unavailable during Tournament fallback.",
      }, 503);
    }
    if (referralOnly) {
      const consumed = await admin.rpc("roo_consume_reauth_grant", {
        p_token_hash: tokenHash,
        p_user_id: user.id,
        p_purpose: "unlink_identity",
        p_provider: provider,
      });
      response.cookies.set(clearReauthCookie());
      if (consumed.error) {
        return jsonFrom(response, { ok: false, error: "Reauthentication expired. Confirm your identity again.", reauthRequired: true }, 409);
      }
      if (identity) {
        const unlinked = await client.auth.unlinkIdentity(identity);
        if (unlinked.error) throw unlinked.error;
      }
    }
    if (referralOnly) {
      const reconciled = await admin.rpc("roo_reconcile_auth_identity_links", {
        p_user_id: user.id,
      });
      if (reconciled.error) throw reconciled.error;
      return jsonFrom(response, { ok: true, provider });
    }
    const sessionExpiresAt = new Date(Number(session.expires_at || 0) * 1000);
    if (!Number.isFinite(sessionExpiresAt.getTime()) || sessionExpiresAt <= new Date()) {
      return jsonFrom(response, { ok: false, error: "Sign in again before unlinking an account." }, 401);
    }
    const command = await queueTourneyDiscordIdentityUnlinkProjection({
      accessToken: session.access_token,
      commandId: `identity-unlink:${provider}:${user.id}:${tokenHash.slice(0, 24)}`,
      expiresAt: sessionExpiresAt.toISOString(),
      identityId: identity?.identity_id || identity?.id || "already-unlinked",
      provider,
      reauthTokenHash: tokenHash,
      userId: user.id,
    });
    response.cookies.set(clearReauthCookie());
    return jsonFrom(response, {
      ok: true,
      provider,
      ...(command.syncPending ? { syncPending: true } : {}),
    });
  } catch (error) {
    if (String(error?.code || "") === "42501") {
      return jsonFrom(response, {
        ok: false,
        error: "Reauthentication expired. Confirm your identity again.",
        reauthRequired: true,
      }, 409);
    }
    return jsonFrom(response, { ok: false, error: "Account unlinking is temporarily unavailable." }, 503);
  }
}
