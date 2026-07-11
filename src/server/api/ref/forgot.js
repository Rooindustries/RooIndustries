import { createDataClient as createClient } from "../../data/documentClient.js";
import { Resend } from "resend";
import crypto from "crypto";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { buildResetEmail } from "../../email/referralResetEmail.js";
import { logSafeError } from "../../safeErrorLog.js";

const createResendClient = () => {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  return apiKey ? new Resend(apiKey) : null;
};

const resend = createResendClient();

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ ok: false, error: "Missing email" });
    }

    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (
      normalizedEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
    ) {
      return res.status(200).json({ ok: true, message: "If email exists, link sent." });
    }
    const clientAddress = getClientAddress(req);

    if (
      !(await requireRateLimit(res, {
        key: `ref-forgot:${clientAddress}`,
        max: 5,
        windowMs: 30 * 60 * 1000,
      }))
    ) {
      return;
    }

    // 3. Find the user by Email
    const referral = await client.fetch(
      `*[_type == "referral" && creatorEmail == $email][0]{ _id, name }`,
      { email: normalizedEmail }
    );

    if (!referral) {
      return res
        .status(200)
        .json({ ok: true, message: "If email exists, link sent." });
    }

    // 4. Generate Token & Expiration (1 hour)
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto
      .createHash("sha256")
      .update(resetToken)
      .digest("hex");
    const resetTokenExpiresAt = new Date(
      Date.now() + 60 * 60 * 1000
    ).toISOString();

    // 5. Save Token to Sanity
    await client
      .patch(referral._id)
      .set({
        resetTokenHash,
        resetTokenExpiresAt: resetTokenExpiresAt,
      })
      .unset(["resetToken"])
      .commit();

    // 6. Send Email via Resend
    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL || "https://www.rooindustries.com";
    const resetLink = `${baseUrl}/referrals/reset#token=${resetToken}`;

    const fromAddress = process.env.FROM_EMAIL || "onboarding@resend.dev";

    if (!resend) {
      console.error("Resend Error: RESEND_API_KEY is not configured");
      return res.status(500).json({ ok: false, error: "Failed to send email" });
    }

    const { error } = await resend.emails.send(
      {
        from: fromAddress,
        to: [normalizedEmail],
        subject: "Reset your Roo Industries password",
        react: buildResetEmail({ name: referral.name, resetLink }),
      },
      { idempotencyKey: `ref-reset-${resetTokenHash.slice(0, 32)}` }
    );

    if (error) {
      logSafeError("Referral reset email failed", error);
      return res.status(500).json({ ok: false, error: "Failed to send email" });
    }

    return res.status(200).json({ ok: true, message: "Reset link sent" });
  } catch (err) {
    logSafeError("Referral forgot-password failed", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
