const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const titleCase = (value) =>
  String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const moneyUsd = (value) => {
  const amount = Number(value || 0);
  return `$${amount.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: amount % 1 ? 2 : 0,
  })} USD`;
};

const safeUrl = (value) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
};

const dashboardLink = ({ baseUrl, path }) => {
  const rawBase = String(baseUrl || "").trim();
  if (!rawBase) return "";
  try {
    return new URL(path, rawBase).toString();
  } catch {
    return "";
  }
};

const buildShell = ({ title, intro, rows = [], details = "", cta = null, sampleMode = false }) => {
  const sampleNotice = sampleMode
    ? `<p style="margin:0 0 16px;padding:12px 14px;border-radius:10px;background:#fef3c7;color:#92400e"><strong>Sample only:</strong> This is a preview of the tournament email template.</p>`
    : "";
  const rowHtml = rows
    .filter((row) => row?.value)
    .map(
      (row) => `
        <tr>
          <td style="padding:7px 12px 7px 0;color:#475569;font-size:13px;vertical-align:top">${escapeHtml(row.label)}</td>
          <td style="padding:7px 0;color:#0f172a;font-weight:700;vertical-align:top">${row.value}</td>
        </tr>`
    )
    .join("");
  const detailsHtml = details
    ? `<div style="margin-top:16px;padding:14px;border-left:4px solid #0891b2;background:#f8fafc;color:#334155">${escapeHtml(details).replace(/\n/g, "<br>")}</div>`
    : "";
  const ctaHtml = cta?.href
    ? `<p style="margin:20px 0 0"><a href="${escapeHtml(cta.href)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#0891b2;color:#fff;text-decoration:none;font-weight:700">${escapeHtml(cta.label)}</a></p>`
    : "";

  return `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#0f172a;max-width:640px">
      ${sampleNotice}
      <h2 style="margin:0 0 10px;color:#0f172a">${escapeHtml(title)}</h2>
      <p style="margin:0 0 14px;color:#334155">${escapeHtml(intro)}</p>
      <table role="presentation" style="border-collapse:collapse;width:100%;margin-top:8px">
        <tbody>${rowHtml}</tbody>
      </table>
      ${detailsHtml}
      ${ctaHtml}
      <p style="margin:18px 0 0;color:#64748b;font-size:13px">Roo Industries Overwatch 6v6 Legacy Series</p>
    </div>
  `;
};

const prefixSubject = ({ subject, sampleMode }) =>
  sampleMode ? `[Sample] ${subject}` : subject;

function buildTourneyAppealAdminEmail({
  appeal = {},
  submitter = {},
  baseUrl = "",
  sampleMode = false,
} = {}) {
  const title = appeal.title || "Tournament appeal";
  const appealUrl = dashboardLink({ baseUrl, path: "/tourney/appeals" });
  const evidenceUrl = safeUrl(appeal.evidenceUrl);
  return {
    subject: prefixSubject({
      subject: `Tourney appeal submitted: ${title}`,
      sampleMode,
    }),
    html: buildShell({
      sampleMode,
      title: "New tournament appeal",
      intro: `${submitter.name || appeal.submitterUsername || "A player"} submitted an appeal for review.`,
      rows: [
        { label: "Appeal type", value: escapeHtml(titleCase(appeal.type)) },
        { label: "Title", value: escapeHtml(title) },
        { label: "Team", value: escapeHtml(appeal.teamName || "TBD") },
        { label: "Captain", value: escapeHtml(appeal.captainName || "TBD") },
        { label: "Subject player", value: escapeHtml(appeal.subjectName || "N/A") },
        { label: "Submitted by", value: escapeHtml(submitter.name || appeal.submitterUsername || "Player") },
        {
          label: "Evidence",
          value: evidenceUrl
            ? `<a href="${escapeHtml(evidenceUrl)}" style="color:#0891b2">${escapeHtml(evidenceUrl)}</a>`
            : "Not provided",
        },
        { label: "Status", value: escapeHtml(titleCase(appeal.status || "open")) },
      ],
      details: appeal.details || "",
      cta: appealUrl ? { href: appealUrl, label: "Open appeals dashboard" } : null,
    }),
    text: `New tournament appeal: ${title}\nTeam: ${appeal.teamName || "TBD"}\nCaptain: ${appeal.captainName || "TBD"}\nDetails: ${appeal.details || ""}`,
  };
}

function buildTourneyAppealConfirmationEmail({
  appeal = {},
  baseUrl = "",
  sampleMode = false,
} = {}) {
  const title = appeal.title || "Tournament appeal";
  const appealUrl = dashboardLink({ baseUrl, path: "/tourney/appeals" });
  return {
    subject: prefixSubject({
      subject: "We received your Roo tourney appeal",
      sampleMode,
    }),
    html: buildShell({
      sampleMode,
      title: "Appeal received",
      intro: "Your appeal is logged. A host or admin will review it and update the appeal record.",
      rows: [
        { label: "Title", value: escapeHtml(title) },
        { label: "Team", value: escapeHtml(appeal.teamName || "TBD") },
        { label: "Captain", value: escapeHtml(appeal.captainName || "TBD") },
        { label: "Status", value: escapeHtml(titleCase(appeal.status || "open")) },
      ],
      details:
        "Keep any evidence links available. Rule breaks may still result in immediate penalty or disqualification while the appeal is reviewed.",
      cta: appealUrl ? { href: appealUrl, label: "View your appeal" } : null,
    }),
    text: `Appeal received: ${title}\nTeam: ${appeal.teamName || "TBD"}\nStatus: ${appeal.status || "open"}`,
  };
}

function buildTourneyPayoutNotificationEmail({
  payout = {},
  baseUrl = "",
  sampleMode = false,
} = {}) {
  const payoutUrl = dashboardLink({ baseUrl, path: "/tourney/payouts" });
  return {
    subject: prefixSubject({
      subject: `Tournament payout update: ${titleCase(payout.status || "pending")}`,
      sampleMode,
    }),
    html: buildShell({
      sampleMode,
      title: "Tournament payout update",
      intro: "Your tournament payout record has been updated.",
      rows: [
        { label: "Player", value: escapeHtml(payout.displayName || "Player") },
        { label: "Team", value: escapeHtml(payout.teamName || "TBD") },
        { label: "Payout type", value: escapeHtml(titleCase(payout.payoutType || "payout")) },
        { label: "Amount", value: escapeHtml(moneyUsd(payout.amountUsd)) },
        { label: "Status", value: escapeHtml(titleCase(payout.status || "pending")) },
        { label: "Payout email", value: escapeHtml(payout.payoutEmail || "To be confirmed") },
      ],
      details:
        payout.notes ||
        "Payouts are finalized after final tournament results are confirmed. Roo Industries does not cover PayPal transaction fees.",
      cta: payoutUrl ? { href: payoutUrl, label: "View payout status" } : null,
    }),
    text: `Tournament payout update\nPlayer: ${payout.displayName || "Player"}\nAmount: ${moneyUsd(payout.amountUsd)}\nStatus: ${payout.status || "pending"}`,
  };
}

module.exports = {
  buildTourneyAppealAdminEmail,
  buildTourneyAppealConfirmationEmail,
  buildTourneyPayoutNotificationEmail,
};
