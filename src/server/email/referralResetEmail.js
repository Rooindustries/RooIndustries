import React from "react";
import { formatLinkExpiry } from "./linkExpiry.js";

const escapeHtml = (value) =>
  String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const buildResetEmail = ({ name = "there", resetLink, expiresAt }) =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement("p", null, `Hi ${name || "there"},`),
    React.createElement("p", null, "Use the button below to choose a new password."),
    React.createElement(
      "p",
      null,
      React.createElement(
        "a",
        { href: resetLink },
        React.createElement("strong", null, "Reset password")
      )
    ),
    React.createElement(
      "p",
      null,
      `${formatLinkExpiry(expiresAt)} If you did not request it, you can ignore this email.`
    )
  );

export const buildResetEmailHtml = ({ name = "there", resetLink, expiresAt }) =>
  [
    `<p>Hi ${escapeHtml(name || "there")},</p>`,
    "<p>Use the button below to choose a new password.</p>",
    `<p><a href="${escapeHtml(resetLink)}"><strong>Reset password</strong></a></p>`,
    `<p>${formatLinkExpiry(expiresAt)} If you did not request it, you can ignore this email.</p>`,
  ].join("");
