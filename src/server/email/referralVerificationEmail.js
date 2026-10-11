import React from "react";
import { formatLinkExpiry } from "./linkExpiry.js";

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const buildReferralVerificationEmail = ({ name = "there", verifyLink, expiresAt }) =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement("p", { style: { overflowWrap: "anywhere", wordBreak: "break-word" } }, `Hi ${name || "there"},`),
    React.createElement(
      "p",
      null,
      "Confirm this email to finish creating your Roo Industries creator account."
    ),
    React.createElement(
      "p",
      null,
      React.createElement(
        "a",
        { href: verifyLink },
        React.createElement("strong", null, "Confirm creator account")
      )
    ),
    React.createElement(
      "p",
      null,
      `${formatLinkExpiry(expiresAt)} If you did not start this signup, you can ignore it.`
    )
  );

export const buildReferralVerificationEmailHtml = ({
  name = "there",
  verifyLink,
  expiresAt,
}) =>
  [
    `<p style="overflow-wrap:anywhere;word-break:break-word">Hi ${escapeHtml(name || "there")},</p>`,
    "<p>Confirm this email to finish creating your Roo Industries creator account.</p>",
    `<p><a href="${escapeHtml(verifyLink)}"><strong>Confirm creator account</strong></a></p>`,
    `<p>${formatLinkExpiry(expiresAt)} If you did not start this signup, you can ignore it.</p>`,
  ].join("");
