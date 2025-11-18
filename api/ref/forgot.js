import { createClient } from "@sanity/client";
import { Resend } from "resend";
import crypto from "crypto";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const resend = new Resend(process.env.RESEND_API_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const { email } = req.body || {};

    if (!email) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing email in request" });
    }

    const referral = await client.fetch(
      `*[_type == "referral" && creatorEmail == $email][0]{
        _id,
        name,
        "code": slug.current
      }`,
      { email }
    );

    if (!referral) {
      return res.json({ ok: true });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await client
      .patch(referral._id)
      .set({
        resetToken: token,
        resetTokenExpiresAt: expiresAt,
      })
      .commit();

    const siteUrl = process.env.SITE_URL || "https://www.rooindustries.com";

    const resetLink = `${siteUrl}/referrals/reset?token=${encodeURIComponent(
      token
    )}`;

    console.log("🔗 Reset link:", resetLink);

    const from = process.env.FROM_EMAIL;
    if (!from || !process.env.RESEND_API_KEY) {
      console.warn("Missing FROM_EMAIL or RESEND_API_KEY");
      return res.json({ ok: true });
    }

    await resend.emails.send({
      from,
      to: email,
      subject: "Reset your Roo Industries referral password",
      html: `
        <div style="font-family:Arial,sans-serif;background:#020617;padding:24px;color:#e5e7eb">
          <div style="max-width:480px;margin:0 auto;background:#0b1120;border:1px solid #0ea5e9;border-radius:12px;padding:20px">
            <h2 style="color:#7dd3fc;margin-bottom:8px;">Password Reset</h2>
            <p style="margin-bottom:16px;">Hi ${
              referral.name || "creator"
            }, click the button below to reset your referral dashboard password.</p>
            <p style="margin-bottom:20px;">
              <a href="${resetLink}" 
                 style="display:inline-block;padding:10px 18px;background:#0ea5e9;color:white;
                        border-radius:999px;text-decoration:none;font-weight:bold;">
                Reset Password
              </a>
            </p>
            <p style="font-size:12px;color:#9ca3af;margin-top:16px;">
              This link expires in 1 hour. If you didn't request this, you can ignore this email.
            </p>
          </div>
        </div>
      `,
    });

    return res.json({ ok: true });
  } catch (err) {
    console.error("FORGOT ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
