import { createClient } from "@sanity/client";
import { Resend } from "resend";
import crypto from "crypto";

// 1. Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);

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

    // 3. Find the user by Email
    const referral = await client.fetch(
      `*[_type == "referral" && creatorEmail == $email][0]{ _id, name }`,
      { email }
    );

    if (!referral) {
      return res
        .status(200)
        .json({ ok: true, message: "If email exists, link sent." });
    }

    // 4. Generate Token & Expiration (1 hour)
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenExpiresAt = new Date(
      Date.now() + 60 * 60 * 1000
    ).toISOString();

    // 5. Save Token to Sanity
    await client
      .patch(referral._id)
      .set({
        resetToken: resetToken,
        resetTokenExpiresAt: resetTokenExpiresAt,
      })
      .commit();

    // 6. Send Email via Resend
    const baseUrl =
      process.env.NEXT_PUBLIC_BASE_URL || "https://www.rooindustries.com";
    const resetLink = `${baseUrl}/referrals/reset?token=${resetToken}`;

    const fromAddress = process.env.FROM_EMAIL || "onboarding@resend.dev";

    const { data, error } = await resend.emails.send({
      from: fromAddress,
      to: [email],
      subject: "Reset your Password",
      html: `
        <p>Hi ${referral.name || "there"},</p>
        <p>You requested a password reset. Click the link below to set a new password:</p>
        <p><a href="${resetLink}"><strong>Reset Password</strong></a></p>
        <p>Or copy this link: ${resetLink}</p>
        <p>This link expires in 1 hour.</p>
      `,
    });

    if (error) {
      console.error("Resend Error:", error);
      return res.status(500).json({ ok: false, error: "Failed to send email" });
    }

    return res.status(200).json({ ok: true, message: "Reset link sent" });
  } catch (err) {
    console.error("FORGOT API ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
