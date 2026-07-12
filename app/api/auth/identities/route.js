import { NextResponse } from "next/server";
import { resolveSupabaseAccountByUserId } from "../../../../src/server/supabase/accounts";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { hashReauthToken, readReauthToken } from "../../../../src/server/supabase/reauth";
import {
  createNextSupabaseSessionClient,
  getNextSupabaseUser,
} from "../../../../src/server/supabase/serverSession";

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
      (account?.connected_providers || sessionProviders)
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
  if (!allProviders.has(provider)) {
    return noStore(NextResponse.json({ ok: false, error: "Provider is invalid." }, { status: 400 }));
  }
  const response = NextResponse.json({ ok: true });
  try {
    const client = createNextSupabaseSessionClient({ request, response });
    const userResult = await client.auth.getUser();
    const user = userResult.data?.user;
    if (userResult.error || !user?.id) {
      return jsonFrom(response, { ok: false, error: "Sign in again before unlinking an account." }, 401);
    }
    const identity = (user.identities || []).find(
      (candidate) => String(candidate?.provider || "").toLowerCase() === provider
    );
    if (!identity || (user.identities || []).length < 2) {
      return jsonFrom(response, { ok: false, error: "Keep at least one sign-in method connected." }, 409);
    }
    const reauthToken = readReauthToken(request);
    if (!reauthToken) {
      return jsonFrom(response, { ok: false, error: "Reauthenticate before unlinking a provider.", reauthRequired: true }, 409);
    }
    const admin = createSupabaseAdminClient();
    const consumed = await admin.rpc("roo_consume_reauth_grant", {
      p_token_hash: hashReauthToken(reauthToken),
      p_user_id: user.id,
      p_purpose: "unlink_identity",
      p_provider: provider,
    });
    if (consumed.error) {
      return jsonFrom(response, { ok: false, error: "Reauthentication expired. Confirm your identity again.", reauthRequired: true }, 409);
    }
    const unlinked = await client.auth.unlinkIdentity(identity);
    if (unlinked.error) throw unlinked.error;
    await admin.rpc("roo_reconcile_auth_identity_links", { p_user_id: user.id });
    const guildId = String(process.env.DISCORD_GUILD_ID || "").trim();
    if (provider === "discord" && /^[0-9]{5,30}$/.test(guildId)) {
      await admin.rpc("roo_refresh_discord_role_assignment", {
        p_user_id: user.id,
        p_guild_id: guildId,
      });
    }
    return jsonFrom(response, { ok: true, provider });
  } catch {
    return jsonFrom(response, { ok: false, error: "Account unlinking is temporarily unavailable." }, 503);
  }
}
