import { createClient } from "@sanity/client";
import { Resend } from "resend";

const readClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  useCdn: false,
  perspective: "published",
});

const resend = new Resend(process.env.RESEND_API_KEY);

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://your-site-domain.com";

export default async function handler(req, res) {
  // --------- GET: your old logic (by id) ---------
  if (req.method === "GET") {
    try {
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ ok: false, error: "Missing creator id" });
      }

      const referral = await readClient.fetch(
        `*[_type == "referral" && _id == $id][0]{
          _id,
          name,
          slug,
          creatorEmail,
          currentCommissionPercent,
          currentDiscountPercent,
          maxCommissionPercent,
          successfulReferrals,
          isFirstTime
        }`,
        { id }
      );

      if (!referral) {
        return res.status(404).json({ ok: false, error: "Referral not found" });
      }

      return res.status(200).json({ ok: true, referral });
    } catch (err) {
      console.error("💥 getData ERROR:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  }

  // --------- POST: forgot password by email ---------
  if (req.method === "POST") {
    try {
      const { email } = req.body || {};

      if (!email) {
        return res.status(400).json({ ok: false, error: "Email is required" });
      }

      // Find referral by creatorEmail
      const referral = await readClient.fetch(
        `*[_type == "referral" && creatorEmail == $email][0]{
          _id,
          name,
          creatorEmail
        }`,
        { email }
      );

      // For security, don't reveal whether email exists
      if (!referral) {
        console.log("🔍 No referral found for email:", email);
        return res
          .status(200)
          .json({ ok: true, message: "If the email exists, a link was sent." });
      }

      const resetLink = `${SITE_URL}/referrals/reset?id=${referral._id}`;

      await resend.emails.send({
        from: "Roo Industries <no-reply@rooindustries.com>",
        to: [referral.creatorEmail],
        subject: "Reset your referral password",
        html: `
          <div style="font-family: Inter, Arial, sans-serif; background: #020617; padding: 32px; color: #e5f2ff;">
            <div style="max-width: 480px; margin: 0 auto; background: #020617; border-radius: 16px; border: 1px solid rgba(56,189,248,0.4); padding: 24px;">
              <h1 style="font-size: 22px; margin-bottom: 12px; color: #7dd3fc;">
                Reset your password
              </h1>
              <p style="font-size: 14px; color: #cbd5f5; line-height: 1.6;">
                Hi ${referral.name || "there"},<br/><br/>
                We received a request to reset the password for your referral account.
              </p>
              <p style="margin: 20px 0;">
                <a href="${resetLink}" 
                   style="display:inline-block;background:#0ea5e9;color:white;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600;font-size:14px;">
                  Reset Password
                </a>
              </p>
              <p style="font-size: 12px; color: #94a3b8; line-height: 1.6;">
                If you didn’t request this, you can safely ignore this email.
              </p>
            </div>
          </div>
        `,
      });

      return res
        .status(200)
        .json({ ok: true, message: "Reset email sent if account exists." });
    } catch (err) {
      console.error("💥 forgot POST ERROR:", err);
      return res.status(500).json({ ok: false, error: "Server error" });
    }
  }

  // --------- Other methods ---------
  res.setHeader("Allow", ["GET", "POST"]);
  return res.status(405).json({ ok: false, error: "Method not allowed" });
}
