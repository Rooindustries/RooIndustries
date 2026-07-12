import { NextResponse } from "next/server";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { createSupabaseAdminClient } from "../../../../src/server/supabase/adminClient";
import {
  clearReauthCookie,
  hashReauthToken,
  readReauthToken,
} from "../../../../src/server/supabase/reauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const noStore = (response) => {
  response.headers.set("Cache-Control", "private, no-store");
  return response;
};

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return noStore(NextResponse.json({ ok: false, error: "Cross-origin request rejected." }, { status: 403 }));
  }
  const primary = readReauthToken(request, "primary");
  const secondary = readReauthToken(request, "secondary");
  if (!primary || !secondary) {
    return noStore(NextResponse.json({ ok: false, error: "Authenticate both accounts before merging." }, { status: 409 }));
  }
  const result = await createSupabaseAdminClient().rpc("roo_merge_account_principals", {
    p_primary_grant_hash: hashReauthToken(primary),
    p_secondary_grant_hash: hashReauthToken(secondary),
  });
  const status = result.error?.code === "23505" ? 409 : result.error ? 503 : 200;
  const response = NextResponse.json(
    result.error
      ? { ok: false, error: status === 409 ? "These accounts have conflicting Referral or Tourney records. An administrator must review them." : "Account merge is temporarily unavailable." }
      : { ok: true, account: result.data },
    { status }
  );
  response.cookies.set(clearReauthCookie("primary"));
  response.cookies.set(clearReauthCookie("secondary"));
  return noStore(response);
}
