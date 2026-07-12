import { clearReferralSessionCookie } from "./auth.js";
import { clearLegacySupabaseSession } from "../../supabase/serverSession.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  clearReferralSessionCookie(res);
  await clearLegacySupabaseSession({ req, res }).catch(() => {});
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({ ok: true });
}
