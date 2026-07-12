import { NextResponse } from "next/server";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { getClientAddressFromFetchHeaders } from "../../../../src/server/request/clientAddress";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { resolveSupabaseAccountByUserId } from "../../../../src/server/supabase/accounts";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient";
import { createSupabaseAuthClient } from "../../../../src/server/supabase/authClient";
import { consumeAuthRateLimit } from "../../../../src/server/supabase/authRateLimit";
import { resolveExactDomainIdentity } from "../../../../src/server/supabase/domainIdentity";
import {
  createReauthToken,
  hashReauthToken,
  reauthCookie,
} from "../../../../src/server/supabase/reauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const purposes = new Set([
  "link_identity",
  "unlink_identity",
  "merge_account",
  "change_password",
]);
const providers = new Set(["google", "discord"]);
const flows = new Set(["referral", "tourney"]);
const slots = new Set(["", "primary", "secondary"]);
const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

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
  const flow = String(payload.flow || "").trim().toLowerCase();
  const purpose = String(payload.purpose || "").trim().toLowerCase();
  const provider = String(payload.provider || "").trim().toLowerCase();
  const slot = String(payload.slot || "").trim().toLowerCase();
  const password = String(payload.password || "");
  if (!flows.has(flow) || !purposes.has(purpose) || !slots.has(slot) || (provider && !providers.has(provider))) {
    return noStore(NextResponse.json({ ok: false, error: "Reauthentication request is invalid." }, { status: 400 }));
  }
  const response = NextResponse.json({ ok: true });
  try {
    const identity = await resolveExactDomainIdentity({ flow, request, response });
    if (!identity?.user?.id || !identity.account?.principal_id) {
      return noStore(NextResponse.json({ ok: false, error: "Sign in again before changing account security." }, { status: 401 }));
    }
    const clientAddress = getClientAddressFromFetchHeaders(request.headers);
    const ipLimit = await consumeAuthRateLimit({
      identity: `auth-attempt:${clientAddress}`,
      max: 20,
    });
    const principalLimit = await consumeAuthRateLimit({
      identity: `auth-sensitive:${identity.account.principal_id}:${provider || purpose}`,
      max: 5,
    });
    if (!ipLimit.allowed || !principalLimit.allowed) {
      const retryAfter = Math.max(ipLimit.retryAfter, principalLimit.retryAfter);
      const limited = NextResponse.json({ ok: false, error: "Too many attempts. Try again shortly." }, { status: 429 });
      limited.headers.set("Retry-After", String(retryAfter));
      return noStore(limited);
    }
    if (!password) {
      const connected = (identity.account.connected_providers || []).filter((value) => providers.has(value));
      return noStore(NextResponse.json({
        ok: false,
        error: "Reauthenticate with your password or a connected provider.",
        reauthRequired: true,
        providers: connected,
      }, { status: 409 }));
    }
    const loginEmail = String(identity.account.primary_email || "").trim().toLowerCase();
    if (!loginEmail || password.length > 128) {
      return noStore(NextResponse.json({ ok: false, error: "Password reauthentication is unavailable for this account." }, { status: 409 }));
    }
    const signedIn = await createSupabaseAuthClient().auth.signInWithPassword({
      email: loginEmail,
      password,
    });
    const authenticatedAccount = signedIn.data?.user?.id
      ? await resolveSupabaseAccountByUserId({ userId: signedIn.data.user.id })
      : null;
    if (signedIn.error || authenticatedAccount?.principal_id !== identity.account.principal_id) {
      return noStore(NextResponse.json({ ok: false, error: "Password is incorrect." }, { status: 401 }));
    }
    const token = createReauthToken();
    const grant = await createSupabaseAdminClient().rpc("roo_create_reauth_grant", {
      p_user_id: identity.user.id,
      p_token_hash: hashReauthToken(token),
      p_purpose: purpose,
      p_provider: provider || null,
    });
    if (grant.error) throw grant.error;
    const finalResponse = NextResponse.json({ ok: true, expiresAt: grant.data?.expires_at || "" });
    for (const cookie of response.cookies.getAll()) finalResponse.cookies.set(cookie);
    finalResponse.cookies.set(reauthCookie(token, slot));
    return noStore(finalResponse);
  } catch {
    return noStore(NextResponse.json({ ok: false, error: "Reauthentication is temporarily unavailable." }, { status: 503 }));
  }
}
