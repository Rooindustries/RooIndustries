import crypto from "node:crypto";
import { Resend } from "resend";
import tourneyEmailTemplates from "./emailTemplates.cjs";
import {
  getTourneyDiscordInviteUrl,
  getTourneyDiscordOAuthConfig,
} from "./discordConfig.js";
import { buildTourneyDiscordStartUrl } from "./discordOAuth.js";

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

const sendWithIdempotency = (resend, message, idempotencyKey = "", signal) => {
  const options = {
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(signal ? { signal } : {}),
  };
  return Object.keys(options).length > 0
    ? resend.emails.send(message, options)
    : resend.emails.send(message);
};

const buildDecisionUrl = ({ baseUrl, token, purpose, role }) => {
  const url = new URL("/tourney/decision", baseUrl);
  const fragment = new URLSearchParams({ token, decision: purpose });
  if (role) fragment.set("role", role);
  url.hash = fragment.toString();
  return url.toString();
};

const getTokenForPurpose = (tokens, purpose) =>
  tokens.find((token) => token.purpose === purpose);

const getPrimaryRolePlay = (player = {}) =>
  String(player.primaryRolePlay || player.role_play || player.rolePlay || "")
    .trim();

const getSecondaryRolePlay = (player = {}) =>
  String(player.secondaryRolePlay || player.secondary_role_play || "").trim();

const getApprovedRolePlay = (player = {}) =>
  String(
    player.approvedRolePlay ||
      player.approved_role_play ||
      player.rolePlay ||
      player.role_play ||
      ""
  ).trim();

const getApprovalRoleOptions = (player = {}) =>
  [...new Set([getPrimaryRolePlay(player), getSecondaryRolePlay(player)])].filter(
    Boolean
  );

const getPoolLabel = (player = {}) =>
  player.registrationPool === "substitute" ||
  player.registration_pool === "substitute"
    ? "substitute pool"
    : "main pool";

export {
  buildTourneyAppealAdminEmail,
  buildTourneyAppealConfirmationEmail,
  buildTourneyPayoutNotificationEmail,
};

const normalizeRecipients = (to) =>
  (Array.isArray(to) ? to : [to])
    .map((recipient) => String(recipient || "").trim())
    .filter(Boolean);

const cryptoSafeRecipientKey = (recipient) =>
  crypto
    .createHash("sha256")
    .update(String(recipient || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);

const sendTemplateEmail = async ({
  to,
  template,
  idempotencyKey = "",
  signal,
  env = process.env,
} = {}) => {
  const recipients = normalizeRecipients(to);
  if (recipients.length === 0) {
    throw new Error("At least one email recipient is required.");
  }
  const resend = getResend(env);
  const from = getFromAddress(env);
  const { data, error } = await sendWithIdempotency(
    resend,
    {
      from,
      to: recipients,
      subject: template.subject,
      html: template.html,
      text: template.text,
    },
    idempotencyKey,
    signal
  );
  if (error) {
    throw Object.assign(new Error("Unable to send Roo Industries email."), {
      code: "tourney_email_send_failed",
    });
  }
  return data;
};

const warnMissingDiscordInvite = ({ env = process.env } = {}) => {
  if (env.NODE_ENV === "test") return;
  console.warn(
    "TOURNEY_DISCORD_INVITE_URL is not configured; Roo Industries Discord CTA omitted."
  );
};

const resolveDiscordLink = ({ player, baseUrl, env = process.env } = {}) => {
  const config = getTourneyDiscordOAuthConfig({ baseUrl, env });
  const discordUrl = config.enabled
    ? buildTourneyDiscordStartUrl({ player, baseUrl, env })
    : getTourneyDiscordInviteUrl(env);
  if (!discordUrl) warnMissingDiscordInvite({ env });
  return {
    url: discordUrl,
    usesOAuth: config.enabled && discordUrl.includes("/tourney/discord"),
  };
};

const ctaLink = ({ href, label, background = "#0891b2", marginRight = false }) =>
  href
    ? `<a href="${escapeHtml(href)}" style="display:inline-block;${
        marginRight ? "margin-right:12px;" : ""
      }padding:12px 18px;border-radius:10px;background:${background};color:#fff;text-decoration:none;font-weight:700">${escapeHtml(
        label
      )}</a>`
    : "";

export function buildTourneyDiscordInviteEmailTemplate({
  player = {},
  baseUrl,
  sampleMode = false,
  env = process.env,
} = {}) {
  const loginUrl = new URL("/tourney/login", baseUrl).toString();
  const sampleInviteUrl = sampleMode ? getTourneyDiscordInviteUrl(env) : "";
  const discordLink = sampleInviteUrl
    ? { url: sampleInviteUrl, usesOAuth: false }
    : resolveDiscordLink({ player, baseUrl, env });
  const discordUrl = discordLink.url;
  const displayName = player.displayName || player.discord || "Player";
  const subject = sampleMode
    ? "[Sample] Roo Industries Discord invite"
    : "Join the Roo Industries Discord";
  const sampleNotice = sampleMode
    ? `<p style="margin:0 0 16px;padding:12px 14px;border-radius:10px;background:#fef3c7;color:#92400e"><strong>Sample only:</strong> This email preview is for Roo Industries only.</p>`
    : "";
  const discordParagraph = discordUrl
    ? `<p>${
        discordLink.usesOAuth
          ? "Use the Discord button below to join or verify your Discord account. Once verified, the Participant role will be assigned automatically."
          : "Use the Discord button below to join the Roo Industries Discord."
      }</p>
       <p>${ctaLink({
         href: discordUrl,
         label: "Join Roo Industries Discord",
         marginRight: true,
       })}${ctaLink({ href: loginUrl, label: "Sign in", background: "#334155" })}</p>`
    : `<p>You can sign in with your Discord username or email to view tournament details.</p>
       <p>${ctaLink({ href: loginUrl, label: "Sign in" })}</p>`;

  return {
    subject,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
        ${sampleNotice}
        <h2>${sampleMode ? "Sample: " : ""}Roo Industries Discord access</h2>
        <p><strong>${escapeHtml(displayName)}</strong> is approved for the Roo Industries Overwatch 6v6 Legacy Series.</p>
        ${discordParagraph}
        <p style="font-size:13px;color:#475569">Roo Industries Overwatch 6v6 Legacy Series</p>
      </div>
    `,
    text: [
      sampleMode ? "Sample only: Roo Industries Discord invite." : "",
      `${displayName} is approved for the Roo Industries Overwatch 6v6 Legacy Series.`,
      discordUrl
        ? `${
            discordLink.usesOAuth
              ? "Join or verify Discord for the Participant role"
              : "Join Roo Industries Discord"
          }: ${discordUrl}`
        : "",
      `Tournament login: ${loginUrl}`,
    ]
      .filter(Boolean)
      .join("\n"),
  };
}

export async function sendTourneyAppealAdminEmail({
  appeal,
  submitter,
  recipients = [],
  baseUrl,
  sampleMode = false,
  idempotencyKey = "",
  signal,
  env = process.env,
} = {}) {
  return sendTemplateEmail({
    to: recipients,
    idempotencyKey,
    signal,
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
  idempotencyKey = "",
  signal,
  env = process.env,
} = {}) {
  return sendTemplateEmail({
    to,
    idempotencyKey,
    signal,
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
  idempotencyKey = "",
  signal,
  env = process.env,
} = {}) {
  return sendTemplateEmail({
    to,
    idempotencyKey,
    signal,
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
  idempotencyKey = "",
  signal,
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

    const approvalRoles = getApprovalRoleOptions(player);
    const approveButtons = approvalRoles
      .map((role, index) => {
        const approveUrl = buildDecisionUrl({
          baseUrl,
          token: approveToken.token,
          purpose: "approve",
          role,
        });
        return `<a href="${escapeHtml(approveUrl)}" style="display:inline-block;${
          index === approvalRoles.length - 1 ? "" : "margin-right:12px;"
        }padding:12px 18px;border-radius:10px;background:#0891b2;color:#fff;text-decoration:none;font-weight:700">Accept as ${escapeHtml(
          role
        )}</a>`;
      })
      .join("");
    const denyUrl = buildDecisionUrl({
      baseUrl,
      token: denyToken.token,
      purpose: "deny",
    });

    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h2>New Roo Industries registration</h2>
        <p><strong>${escapeHtml(
          player.displayName || player.discord
        )}</strong> is waiting for approval.</p>
        <ul>
          <li>Display Name: ${escapeHtml(player.displayName || player.discord)}</li>
          <li>Discord: ${escapeHtml(player.discord)}</li>
          <li>Battle.net: ${escapeHtml(player.battlenet)}</li>
          <li>Rank: ${escapeHtml(player.rank)}</li>
          <li>Primary Role: ${escapeHtml(getPrimaryRolePlay(player))}</li>
          ${
            getSecondaryRolePlay(player)
              ? `<li>Secondary Role: ${escapeHtml(getSecondaryRolePlay(player))}</li>`
              : ""
          }
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
          ${approveButtons}
          <a href="${escapeHtml(denyUrl)}" style="display:inline-block;margin-left:${
            approvalRoles.length ? "12px" : "0"
          };padding:12px 18px;border-radius:10px;background:#7f1d1d;color:#fff;text-decoration:none;font-weight:700">Deny</a>
        </p>
        <p style="font-size:13px;color:#475569">These links are single-use and tied to your active caster/owner account.</p>
      </div>
    `;

    const recipientKey = cryptoSafeRecipientKey(recipientEmail);
    const { data, error } = await sendWithIdempotency(
      resend,
      {
        from,
        to: [recipientEmail],
        subject: `Roo Industries registration: ${player.displayName || player.discord}`,
        html,
      },
      idempotencyKey ? `${idempotencyKey}:${recipientKey}`.slice(0, 256) : "",
      signal
    );

    if (error) {
      throw Object.assign(new Error("Unable to send approval email."), {
        code: "tourney_approval_email_failed",
      });
    }

    results.push(data);
  }

  return results;
}

export async function sendTourneyPlayerApprovedEmail({
  player,
  baseUrl,
  idempotencyKey = "",
  signal,
  env = process.env,
} = {}) {
  const resend = getResend(env);
  const from = getFromAddress(env);
  const loginUrl = new URL("/tourney/login", baseUrl);
  const discordLink = resolveDiscordLink({ player, baseUrl, env });
  const discordUrl = discordLink.url;
  const approvedRole = getApprovedRolePlay(player) || "your selected role";
  const poolLabel = getPoolLabel(player);
  const discordCta = discordUrl
    ? `<p>${
        discordLink.usesOAuth
          ? "Join or verify your Discord account so the Participant role can be assigned automatically."
          : "Join the Roo Industries Discord for match coordination and updates."
      }</p>
       <p>${ctaLink({
         href: discordUrl,
         label: "Join Roo Industries Discord",
         marginRight: true,
       })}${ctaLink({
         href: loginUrl.toString(),
         label: "Sign in",
         background: "#334155",
       })}</p>`
    : `<p>You can sign in with your Discord username or email to view tournament details.</p>
       <p>${ctaLink({ href: loginUrl.toString(), label: "Sign in" })}</p>`;

  const { data, error } = await sendWithIdempotency(resend, {
    from,
    to: [player.email],
    subject: `You're approved as ${approvedRole} for Roo Industries`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h2>You're approved</h2>
        <p><strong>${escapeHtml(
          player.displayName || player.discord
        )}</strong> has been approved as <strong>${escapeHtml(
          approvedRole
        )}</strong> for the Roo Industries Overwatch 6v6 Legacy Series.</p>
        <p>Your tournament pool is <strong>${escapeHtml(poolLabel)}</strong>.</p>
        ${discordCta}
      </div>
    `,
    text: [
      `${player.displayName || player.discord || "Player"} has been approved as ${approvedRole} for the Roo Industries Overwatch 6v6 Legacy Series.`,
      `Tournament pool: ${poolLabel}.`,
      discordUrl
        ? `${
            discordLink.usesOAuth
              ? "Join or verify Discord for the Participant role"
              : "Join Roo Industries Discord"
          }: ${discordUrl}`
        : "",
      `Tournament login: ${loginUrl.toString()}`,
    ]
      .filter(Boolean)
      .join("\n"),
  }, idempotencyKey, signal);

  if (error) {
    throw Object.assign(new Error("Unable to send player approval email."), {
      code: "tourney_player_email_failed",
    });
  }

  return data;
}

export async function sendTourneyDiscordInviteEmail({
  player,
  to,
  baseUrl,
  sampleMode = false,
  idempotencyKey = "",
  signal,
  env = process.env,
} = {}) {
  return sendTemplateEmail({
    to: to || player?.email,
    idempotencyKey,
    signal,
    env,
    template: buildTourneyDiscordInviteEmailTemplate({
      player,
      baseUrl,
      sampleMode,
      env,
    }),
  });
}

export async function sendTourneyResetEmail({
  player,
  token,
  baseUrl,
  idempotencyKey = "",
  signal,
  env = process.env,
} = {}) {
  const resend = getResend(env);
  const from = getFromAddress(env);
  const resetUrl = new URL("/tourney/reset", baseUrl);
  resetUrl.hash = `token=${encodeURIComponent(token)}`;

  const { data, error } = await sendWithIdempotency(resend, {
    from,
    to: [player.email],
    subject: "Reset your Roo Industries password",
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a">
        <h2>Reset your Roo Industries password</h2>
        <p>Use this link to set a new password for <strong>${escapeHtml(
          player.discord || player.username
        )}</strong>.</p>
        <p><a href="${resetUrl.toString()}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0891b2;color:#fff;text-decoration:none;font-weight:700">Reset password</a></p>
        <p style="font-size:13px;color:#475569">This link expires in 1 hour.</p>
      </div>
    `,
  }, idempotencyKey, signal);

  if (error) {
    throw Object.assign(new Error("Unable to send reset email."), {
      code: "tourney_reset_email_failed",
    });
  }

  return data;
}
