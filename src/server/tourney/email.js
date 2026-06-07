import { Resend } from "resend";
import tourneyEmailTemplates from "./emailTemplates.cjs";

const DEFAULT_FROM = "Roo Industries <onboarding@resend.dev>";
const {
  buildTourneyAppealAdminEmail,
  buildTourneyAppealConfirmationEmail,
  buildTourneyPayoutNotificationEmail,
} = tourneyEmailTemplates;

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const getResend = (env = process.env) => {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured.");
  }
  return new Resend(apiKey);
};

const getFromAddress = (env = process.env) =>
  String(env.FROM_EMAIL || DEFAULT_FROM).trim();

const buildDecisionUrl = ({ baseUrl, token, purpose }) => {
  const url = new URL("/api/tourney/registration-decision", baseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("decision", purpose);
  return url.toString();
};

const getTokenForPurpose = (tokens, purpose) =>
  tokens.find((token) => token.purpose === purpose);

export {
  buildTourneyAppealAdminEmail,
  buildTourneyAppealConfirmationEmail,
  buildTourneyPayoutNotificationEmail,
};

const normalizeRecipients = (to) =>
  (Array.isArray(to) ? to : [to])
    .map((recipient) => String(recipient || "").trim())
    .filter(Boolean);

const sendTemplateEmail = async ({ to, template, env = process.env } = {}) => {
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    throw new Error("At least one email recipient is required.");
  }
  const resend = getResend(env);
  const from = getFromAddress(env);
  const { data, error } = await resend.emails.send({
    from,
    to: recipients,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
  if (error) {
    throw new Error(error.message || "Unable to send tournament email.");
  }
  return data;
};

export async function sendTourneyAppealAdminEmail({
  appeal,
  submitter,
  recipients = [],
  baseUrl,
  sampleMode = false,
  env = process.env,
} = {}) {
  return sendTemplateEmail({
    to: recipients,
    env,
    template: buildTourneyAppealAdminEmail({
      appeal,
      submitter,
      baseUrl,
      sampleMode,
    }),
  });
}

export async function sendTourneyAppealConfirmationEmail({
  appeal,
  to,
  baseUrl,
  sampleMode = false,
  env = process.env,
} = {}) {
  return sendTemplateEmail({
    to,
    env,
    template: buildTourneyAppealConfirmationEmail({
      appeal,
      baseUrl,
      sampleMode,
    }),
  });
}

export async function sendTourneyPayoutNotificationEmail({
  payout,
  to,
  baseUrl,
  sampleMode = false,
  env = process.env,
} = {}) {
  return sendTemplateEmail({
    to,
    env,
    template: buildTourneyPayoutNotificationEmail({
      payout,
      baseUrl,
      sampleMode,
    }),
  });
}

export async function sendTourneyRegistrationApprovalEmails({
  player,
  tokens = [],
  baseUrl,
  env = process.env,
} = {}) {
  const resend = getResend(env);
  const from = getFromAddress(env);
  const grouped = new Map();

  for (const token of tokens) {
    const key = token.recipient_email;
    grouped.set(key, [...(grouped.get(key) || []), token]);
  }

  const results = [];
  for (const [recipientEmail, recipientTokens] of grouped.entries()) {
    const approveToken = getTokenForPurpose(recipientTokens, "approve");
    const denyToken = getTokenForPurpose(recipientTokens, "deny");
    if (!approveToken || !denyToken) continue;

    const approveUrl = buildDecisionUrl({
      baseUrl,
      token: approveToken.token,
      purpose: "approve",
    });
    const denyUrl = buildDecisionUrl({
      baseUrl,
      token: denyToken.token,
      purpose: "deny",
    });

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h2>New Roo tourney registration</h2>
        <p><strong>${escapeHtml(
          player.displayName || player.discord
        )}</strong> is waiting for approval.</p>
        <ul>
          <li>Display Name: ${escapeHtml(player.displayName || player.discord)}</li>
          <li>Discord: ${escapeHtml(player.discord)}</li>
          <li>Battle.net: ${escapeHtml(player.battlenet)}</li>
          <li>Rank: ${escapeHtml(player.rank)}</li>
          <li>Role: ${escapeHtml(player.rolePlay)}</li>
          <li>Timezone: ${escapeHtml(player.timezone)}</li>
          <li>Twitch: ${escapeHtml(player.twitchUsername)}</li>
          <li>Free on August 15th and 16th: ${player.availableAug12 ? "Yes" : "No"}</li>
        </ul>
        ${
          player.notes
            ? `<p><strong>Notes:</strong> ${escapeHtml(player.notes)}</p>`
            : ""
        }
        <p>
          <a href="${approveUrl}" style="display:inline-block;margin-right:12px;padding:12px 18px;border-radius:10px;background:#0891b2;color:#fff;text-decoration:none;font-weight:700">Approve</a>
          <a href="${denyUrl}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#7f1d1d;color:#fff;text-decoration:none;font-weight:700">Deny</a>
        </p>
        <p style="font-size:13px;color:#475569">These links are single-use and tied to your active caster/owner account.</p>
      </div>
    `;

    const { data, error } = await resend.emails.send({
      from,
      to: [recipientEmail],
      subject: `Tourney registration: ${player.displayName || player.discord}`,
      html,
    });

    if (error) {
      throw new Error(error.message || "Unable to send approval email.");
    }

    results.push(data);
  }

  return results;
}

export async function sendTourneyPlayerApprovedEmail({
  player,
  baseUrl,
  env = process.env,
} = {}) {
  const resend = getResend(env);
  const from = getFromAddress(env);
  const loginUrl = new URL("/tourney/login", baseUrl);

  const { data, error } = await resend.emails.send({
    from,
    to: [player.email],
    subject: "You're approved for the Roo Overwatch tournament",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h2>You're approved</h2>
        <p><strong>${escapeHtml(
          player.displayName || player.discord
        )}</strong> has been approved for the Roo Overwatch tournament.</p>
        <p>You can sign in with your Discord username or email to view tournament details.</p>
        <p><a href="${loginUrl.toString()}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0891b2;color:#fff;text-decoration:none;font-weight:700">Sign in</a></p>
      </div>
    `,
  });

  if (error) {
    throw new Error(error.message || "Unable to send player approval email.");
  }

  return data;
}

export async function sendTourneyResetEmail({
  player,
  token,
  baseUrl,
  env = process.env,
} = {}) {
  const resend = getResend(env);
  const from = getFromAddress(env);
  const resetUrl = new URL("/tourney/reset", baseUrl);
  resetUrl.searchParams.set("token", token);

  const { data, error } = await resend.emails.send({
    from,
    to: [player.email],
    subject: "Reset your Roo tourney password",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h2>Reset your Roo tourney password</h2>
        <p>Use this link to set a new password for <strong>${escapeHtml(
          player.discord || player.username
        )}</strong>.</p>
        <p><a href="${resetUrl.toString()}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0891b2;color:#fff;text-decoration:none;font-weight:700">Reset password</a></p>
        <p style="font-size:13px;color:#475569">This link expires in 1 hour.</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(error.message || "Unable to send reset email.");
  }

  return data;
}
