import { createClient } from "@sanity/client";
import { Resend } from "resend";
import crypto from "crypto";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";

// 1. Initialize Resend
const resend = new Resend(process.env.RESEND_API_KEY);
const DEFAULT_BASE_URL = "https://www.rooindustries.in";
const DEFAULT_LOGO_URL = "https://www.rooindustries.in/email-avatar.gif";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);

const resolveLogoUrl = () =>
  String(
    process.env.EMAIL_LOGO_URL || process.env.LOGO_URL || DEFAULT_LOGO_URL
  ).trim() ||
  DEFAULT_LOGO_URL;

const buildResetEmailHtml = ({ name, resetLink }) => {
  const safeName = escapeHtml(name || "there");
  const safeResetLink = escapeHtml(resetLink);
  const logoUrl = escapeHtml(resolveLogoUrl());

  return `
    <div style="margin:0;padding:0;background:#020617;color:#e2e8f0;font-family:Arial,sans-serif">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#020617;padding:24px 0">
        <tr>
          <td align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;background:#0f172a;border:1px solid rgba(56,189,248,.18);border-radius:18px;padding:28px">
              <tr>
                <td style="text-align:center;padding-bottom:20px">
                  <img src="${logoUrl}" alt="Roo Industries" width="64" height="64" style="width:64px;height:64px;border-radius:50%;display:block;margin:0 auto 10px;background:#020617;border:1px solid rgba(125,211,252,.35)"/>
                  <div style="font-weight:700;font-size:18px;color:#7dd3fc">Roo Industries</div>
                </td>
              </tr>
              <tr>
                <td>
                  <h1 style="margin:0 0 8px;font-size:20px;color:#a5e8ff">Reset your password</h1>
                  <p style="margin:10px 0 16px;opacity:.85">Hi ${safeName},</p>
                  <p style="margin:0 0 16px;opacity:.85">You requested a password reset. Click the button below to set a new password.</p>
                  <p style="margin:0 0 18px">
                    <a href="${safeResetLink}" style="display:inline-block;padding:10px 16px;border-radius:999px;background:#38bdf8;color:#0b1120;font-size:14px;text-decoration:none;font-weight:700">Reset Password</a>
                  </p>
                  <p style="margin:0 0 12px;font-size:13px;color:#94a3b8">Or copy this link: <a href="${safeResetLink}" style="color:#7dd3fc">${safeResetLink}</a></p>
                  <p style="margin:0;font-size:13px;color:#94a3b8">This link expires in 1 hour.</p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </div>
  `;
};

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
    const clientAddress = getClientAddress(req);

    if (
      !requireRateLimit(res, {
        key: `ref-forgot:${clientAddress}:${normalizedEmail || "unknown"}`,
        max: 5,
        windowMs: 30 * 60 * 1000,
      })
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
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || DEFAULT_BASE_URL;
    const resetLink = `${baseUrl}/referrals/reset?token=${resetToken}`;

    const fromAddress = process.env.FROM_EMAIL || "onboarding@resend.dev";

    const { data, error } = await resend.emails.send({
      from: fromAddress,
      to: [normalizedEmail],
      subject: "Reset your Password",
      html: buildResetEmailHtml({
        name: referral.name,
        resetLink,
      }),
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
