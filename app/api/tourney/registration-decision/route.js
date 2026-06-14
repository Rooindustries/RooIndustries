import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  findActiveTourneyApprover,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import { isMatchingTourneyApproverSession } from "../../../../src/server/tourney/access";
import { sendTourneyPlayerApprovedEmail } from "../../../../src/server/tourney/email";
import {
  applyRegistrationDecision,
  getRegistrationDecisionToken,
  hashTourneyToken,
} from "../../../../src/server/tourney/playerStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderDecisionPage = ({
  title,
  body,
  tone = "info",
  linkHref = "/tourney/manage",
  linkLabel = "Open Manage",
}) => {
  const color = tone === "danger" ? "#fed7aa" : "#a5f3fc";
  return new NextResponse(
    `<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>${title}</title>
        <style>
          body {
            min-height: 100vh;
            margin: 0;
            display: grid;
            place-items: center;
            background: linear-gradient(to top,#00b7c0 0%,#006185 30%,#001f5a 65%,#000040 100%);
            color: #fff;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          main {
            width: min(92vw, 560px);
            border: 1px solid rgba(14,165,233,.34);
            border-radius: 16px;
            padding: 32px;
            background: rgba(11,17,32,.84);
            box-shadow: 0 24px 70px rgba(2,6,23,.34);
            text-align: center;
          }
          h1 { margin: 0; font-size: clamp(2rem, 7vw, 3.4rem); line-height: 1; }
          p { color: rgba(226,232,240,.88); font-size: 1rem; line-height: 1.55; }
          strong { color: ${color}; }
          a { color: #7dd3fc; font-weight: 700; }
        </style>
      </head>
      <body>
        <main>
          <h1>${title}</h1>
          <p>${body}</p>
          <p><a href="${linkHref}">${linkLabel}</a></p>
        </main>
      </body>
    </html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    }
  );
};

export async function GET(request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const decision = String(url.searchParams.get("decision") || "").toLowerCase();
  const approvedRolePlay = String(url.searchParams.get("role") || "").trim();

  if (!token || !["approve", "deny"].includes(decision)) {
    return renderDecisionPage({
      title: "Invalid link",
      body: "This approval link is missing required details.",
      tone: "danger",
    });
  }

  try {
    const tokenRow = await getRegistrationDecisionToken({
      token,
      purpose: decision,
    });
    if (!tokenRow) {
      return renderDecisionPage({
        title: "Link expired",
        body: "This approval link was already used, expired, or revoked.",
        tone: "danger",
      });
    }

    const approver = await findActiveTourneyApprover({
      username: tokenRow.recipient_username,
      email: tokenRow.recipient_email,
      version: tokenRow.recipient_version,
    });
    if (!approver) {
      return renderDecisionPage({
        title: "Access revoked",
        body: "This approval link is no longer valid for that caster or owner account.",
        tone: "danger",
      });
    }

    const sessionToken = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
    const session = await readTourneySessionFromStore({ token: sessionToken });
    if (!isMatchingTourneyApproverSession({ session, approver })) {
      const accountLabel = `${approver.role} ${approver.username}`;
      return renderDecisionPage({
        title: session ? "Wrong account" : "Sign in required",
        body: session
          ? `This approval link is assigned to <strong>${escapeHtml(
              accountLabel
            )}</strong>. Sign in with that account before using it.`
          : `Sign in as <strong>${escapeHtml(
              accountLabel
            )}</strong> before using this approval link.`,
        tone: "danger",
        linkHref: "/tourney/login?next=/tourney/manage",
        linkLabel: "Sign in",
      });
    }

    const player = await applyRegistrationDecision({
      tokenHash: hashTourneyToken(token),
      playerId: tokenRow.player_id,
      purpose: decision,
      actorUsername: approver.username,
      approvedRolePlay,
    });

    let emailNotice = "";
    let tone = "info";
    if (decision === "approve") {
      try {
        await sendTourneyPlayerApprovedEmail({
          player,
          baseUrl: url.origin,
        });
        emailNotice = " An approval email was sent to the player.";
      } catch (emailError) {
        console.error("TOURNEY_PLAYER_APPROVED_EMAIL_ERROR:", emailError);
        tone = "danger";
        emailNotice =
          " The player was approved, but the approval email could not be sent.";
      }
    }

    return renderDecisionPage({
      title: decision === "approve" ? "Approved" : "Denied",
      body: `<strong>${escapeHtml(player.displayName || player.discord)}</strong> has been ${
        decision === "approve" ? "approved" : "denied"
      }.${emailNotice}`,
      tone,
    });
  } catch (error) {
    return renderDecisionPage({
      title: "Decision failed",
      body: escapeHtml(error?.message || "Unable to update this registration."),
      tone: "danger",
    });
  }
}
