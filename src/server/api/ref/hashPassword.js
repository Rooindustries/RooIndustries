import bcrypt from "bcryptjs";
import { createDataClient as createClient } from "../../data/documentClient.js";
import { requireReferralSession } from "./auth.js";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const session = requireReferralSession(req, res);
    if (!session) return;
    const creatorId = session.referralId;
    const { password } = req.body || {};
    const normalizedPassword = String(password || "");

    if (normalizedPassword.length < 10 || normalizedPassword.length > 128) {
      return res
        .status(400)
        .json({ ok: false, error: "Use a password between 10 and 128 characters." });
    }
    if (
      !(await requireRateLimit(res, {
        key: `ref-change-password:${getClientAddress(req)}`,
        max: 5,
        windowMs: 30 * 60 * 1000,
      }))
    ) {
      return;
    }

    const passwordChangedAt = new Date().toISOString();
    const hash = await bcrypt.hash(normalizedPassword, 12);

    await client
      .patch(creatorId)
      .set({
        creatorPassword: hash,
        passwordResetRequired: false,
        credentialVersion: 2,
        passwordChangedAt,
      })
      .commit();

    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
