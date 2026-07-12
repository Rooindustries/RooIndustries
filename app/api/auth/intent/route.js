import { NextResponse } from "next/server";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { resolveExactDomainIdentity } from "../../../../src/server/supabase/domainIdentity";
import { consumeAuthRateLimit } from "../../../../src/server/supabase/authRateLimit";
import { getClientAddressFromFetchHeaders } from "../../../../src/server/request/clientAddress";
import {
  createOAuthIntent,
  oauthIntentCookie,
} from "../../../../src/server/supabase/oauthIntents";
import { clearNextSupabaseSession } from "../../../../src/server/supabase/serverSession";
import { REF_SESSION_COOKIE } from "../../../../src/server/api/ref/auth";
import { TOURNEY_SESSION_COOKIE } from "../../../../src/server/tourney/auth";
import { readReauthToken } from "../../../../src/server/supabase/reauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const flows = new Set(["referral", "tourney"]);
const actions = new Set(["signin", "signup", "link", "reauth"]);
const providers = new Set(["google", "discord"]);
const reauthPurposes = new Set([
  "link_identity",
  "unlink_identity",
  "merge_account",
  "change_password",
]);

const defaultPath = ({ action, flow }) => {
  if (action === "signup") {
    return flow === "referral" ? "/referrals/register" : "/tourney/register";
  }
  if (flow === "referral") return "/referrals/dashboard";
  return "/tourney";
};

const safeReturnPath = ({ action, flow, value }) => {
  const fallback = defaultPath({ action, flow });
  const path = String(value || fallback).trim();
  if (
    !/^\/(?!\/)[^\\\u0000-\u001f]*$/.test(path) ||
    path.startsWith("/api/") ||
    path.startsWith("/auth/")
  ) {
    return fallback;
  }
  if (flow === "referral" && !path.startsWith("/referrals/")) return fallback;
  if (flow === "tourney" && !path.startsWith("/tourney")) return fallback;
  if (action === "signup" && path !== fallback) return fallback;
  if (flow === "tourney" && path === "/tourney/login") return fallback;
  return path;
};

const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

const clearDomainSession = (response, flow) => {
  response.cookies.set({
    name: flow === "tourney" ? TOURNEY_SESSION_COOKIE : REF_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
};

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return noStore(
      NextResponse.json(
        { ok: false, error: "Cross-origin request rejected." },
        { status: 403 }
      )
    );
  }

  let payload;
  try {
    payload = await readBoundedJson(request);
  } catch (error) {
    return noStore(
      NextResponse.json(
        { ok: false, error: error.message },
        { status: Number(error.status || 400) }
      )
    );
  }

  const action = String(payload.action || "").trim().toLowerCase();
  const flow = String(payload.flow || "").trim().toLowerCase();
  const provider = String(payload.provider || "").trim().toLowerCase();
  if (!actions.has(action) || !flows.has(flow) || !providers.has(provider)) {
    return noStore(
      NextResponse.json(
        { ok: false, error: "OAuth request is invalid." },
        { status: 400 }
      )
    );
  }

  const returnPath = safeReturnPath({
    action,
    flow,
    value: payload.returnPath,
  });
  const response = NextResponse.json({ ok: true });

  try {
    const clientAddress = getClientAddressFromFetchHeaders(request.headers);
    const ipLimit = await consumeAuthRateLimit({
      identity: `oauth:${clientAddress}`,
      max: 20,
    });
    if (!ipLimit.allowed) {
      const limited = NextResponse.json(
        { ok: false, error: "Too many authentication attempts. Try again shortly." },
        { status: 429 }
      );
      limited.headers.set("Retry-After", String(ipLimit.retryAfter));
      return noStore(limited);
    }
    let domainIdentity = null;
    if (["link", "reauth"].includes(action)) {
      domainIdentity = await resolveExactDomainIdentity({
        flow,
        request,
        response,
      });
      if (!domainIdentity) {
        return noStore(
          NextResponse.json(
            {
              ok: false,
              error: "Sign in with your password again before linking an account.",
            },
            { status: 409 }
          )
        );
      }
      const connectedProviders = new Set(
        (domainIdentity.account.connected_providers || []).map((value) =>
          String(value || "").trim().toLowerCase()
        )
      );
      if (action === "reauth" && !connectedProviders.has(provider)) {
        return noStore(
          NextResponse.json(
            { ok: false, error: "Reauthenticate with an account that is already linked." },
            { status: 409 }
          )
        );
      }
      if (action === "link" && connectedProviders.has(provider)) {
        return noStore(
          NextResponse.json(
            { ok: false, error: "That account is already linked." },
            { status: 409 }
          )
        );
      }
      const principalLimit = await consumeAuthRateLimit({
        identity: `oauth:${domainIdentity.account.principal_id}:${provider}`,
        max: 5,
      });
      if (!principalLimit.allowed) {
        const limited = NextResponse.json(
          { ok: false, error: "Too many authentication attempts. Try again shortly." },
          { status: 429 }
        );
        limited.headers.set(
          "Retry-After",
          String(principalLimit.retryAfter)
        );
        return noStore(limited);
      }
    } else {
      await clearNextSupabaseSession({ request, response }).catch(() => {});
      clearDomainSession(response, flow);
    }

    const reauthPurpose = String(payload.reauthPurpose || "").trim().toLowerCase();
    if (action === "reauth" && !reauthPurposes.has(reauthPurpose)) {
      return noStore(
        NextResponse.json(
          { ok: false, error: "Reauthentication purpose is invalid." },
          { status: 400 }
        )
      );
    }
    const reauthToken = action === "link" ? readReauthToken(request) : "";
    if (action === "link" && !reauthToken) {
      return noStore(
        NextResponse.json(
          { ok: false, error: "Reauthenticate before linking a provider.", reauthRequired: true },
          { status: 409 }
        )
      );
    }

    const intent = await createOAuthIntent({
      action,
      domainSubject: domainIdentity?.domainSubject || "",
      flow,
      provider,
      reauthPurpose,
      reauthToken,
      returnPath,
      targetUserId: domainIdentity?.user?.id || "",
    });
    if (!intent.id) throw new Error("OAuth intent id is missing.");
    const callbackUrl = new URL("/auth/callback", request.url);
    callbackUrl.searchParams.set("intent", intent.id);
    const finalResponse = NextResponse.json({
      ok: true,
      callbackUrl: callbackUrl.toString(),
    });
    for (const cookie of response.cookies.getAll()) finalResponse.cookies.set(cookie);
    finalResponse.cookies.set(oauthIntentCookie(intent.token, intent.id));
    return noStore(finalResponse);
  } catch {
    return noStore(
      NextResponse.json(
        { ok: false, error: "OAuth could not be started. Please try again." },
        { status: 503 }
      )
    );
  }
}
