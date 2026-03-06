import { clearReferralSessionCookie } from "./auth.js";

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  clearReferralSessionCookie(res);
  return res.status(200).json({ ok: true });
}
