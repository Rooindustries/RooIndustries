import { NextResponse } from "next/server";
import { resolveSupabaseAccountByUserId } from "../../../../src/server/supabase/accounts";
import { getNextSupabaseUser } from "../../../../src/server/supabase/serverSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const allowedFlows = new Set(["referral", "tourney"]);

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
  if (flow === "referral") return (account.roles || []).includes("creator");
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
    const providers = [...new Set(
      (user.identities || [])
        .map((identity) => String(identity?.provider || "").toLowerCase())
        .filter((provider) => ["email", "google", "discord"].includes(provider))
    )].sort();
    return jsonFrom(response, {
        ok: true,
        authenticated: true,
        email: user.email_confirmed_at ? String(user.email || "").toLowerCase() : "",
        emailVerified: Boolean(user.email_confirmed_at),
        providers,
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
