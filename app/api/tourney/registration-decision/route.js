import { NextResponse } from "next/server";
import {
  TOURNEY_SESSION_COOKIE,
  findActiveTourneyApprover,
  readTourneySessionFromStore,
} from "../../../../src/server/tourney/auth";
import { isMatchingTourneyApproverSession } from "../../../../src/server/tourney/access";
import { enqueueTourneyEmailDispatch } from "../../../../src/server/tourney/emailDispatch";
import { logSafeError } from "../../../../src/server/safeErrorLog";
import { isSameOriginMutation } from "../../../../src/server/request/sameOrigin";
import { readBoundedJson } from "../../../../src/server/request/boundedJson";
import {
  applyRegistrationDecision,
  getRegistrationDecisionToken,
  hashTourneyToken,
} from "../../../../src/server/tourney/playerStore";
import { executeTourneyCommand } from "../../../../src/server/tourney/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RETRYABLE_DECISION_CONFLICTS = new Set([
  "TOURNEY_AUTH_OPERATION_IN_PROGRESS",
  "TOURNEY_AUTH_LEASE_CHANGED",
  "TOURNEY_TRANSACTION_BUSY",
]);

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
  status = 200,
  retryAfter = 0,
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
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}),
      },
    }
  );
};

const renderDecisionJson = ({
  title,
  body,
  ok = false,
  status = 400,
  linkHref = "",
  retryAfter = 0,
  code = "",
  syncPending = false,
}) =>
  Response.json(
    {
      ok,
      title,
      message: String(body || "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"'),
      ...(linkHref ? { signInUrl: linkHref } : {}),
      ...(code ? { code } : {}),
      ...(syncPending ? { syncPending: true } : {}),
    },
    {
      status,
      headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined,
    }
  );

const handleDecision = async ({
  request,
  token,
  decision,
  approvedRolePlay,
  respond,
}) => {
  const url = new URL(request.url);

  if (!token || !["approve", "deny"].includes(decision)) {
    return respond({
      title: "Invalid link",
      body: "This approval link is missing required details.",
      tone: "danger",
      status: 400,
    });
  }

  try {
    const tokenRow = await getRegistrationDecisionToken({
      token,
      purpose: decision,
      allowUsed: true,
    });
    if (!tokenRow) {
      return respond({
        title: "Link unavailable",
        body: "This approval link was already used, revoked, or is invalid.",
        tone: "danger",
        status: 410,
      });
    }

    const approver = await findActiveTourneyApprover({
      username: tokenRow.recipient_username,
      email: tokenRow.recipient_email,
      version: tokenRow.recipient_version,
    });
    if (!approver) {
      return respond({
        title: "Access revoked",
        body: "This approval link is no longer valid for that caster or owner account.",
        tone: "danger",
        status: 403,
      });
    }

    const sessionToken = request.cookies.get(TOURNEY_SESSION_COOKIE)?.value || "";
    const session = await readTourneySessionFromStore({ token: sessionToken });
    if (!isMatchingTourneyApproverSession({ session, approver })) {
      const accountLabel = `${approver.role} ${approver.username}`;
      return respond({
        title: session ? "Wrong account" : "Sign in required",
        body: session
          ? `This approval link is assigned to <strong>${escapeHtml(
              accountLabel
            )}</strong>. Sign in with that account before using it.`
          : `Sign in as <strong>${escapeHtml(
              accountLabel
            )}</strong> before using this approval link.`,
        tone: "danger",
        linkHref: "/tourney/login?next=/tourney/decision",
        linkLabel: "Sign in",
        status: 401,
      });
    }

    const tokenHash = hashTourneyToken(token);
    const commandId = `token:${tokenHash}:${decision}`;
    const command = await executeTourneyCommand({
      commandId,
      purpose: `players:${decision}`,
      requestPayload: { tokenHash, decision, approvedRolePlay },
      callback: async () => {
        const player = await applyRegistrationDecision({
          tokenHash,
          playerId: tokenRow.player_id,
          purpose: decision,
          actorUsername: approver.username,
          approvedRolePlay,
        });
        if (decision === "approve") {
          await enqueueTourneyEmailDispatch({
            commandId,
            dispatchKind: "approval",
            recipient: player.email,
            payload: { player, baseUrl: url.origin },
          });
        }
        return { body: { player } };
      },
    });
    const player = command.body.player;
    const emailNotice = decision === "approve"
      ? " An approval email was queued for the player."
      : "";

    return respond({
      title: decision === "approve" ? "Approved" : "Denied",
      body: `<strong>${escapeHtml(player.displayName || player.discord)}</strong> has been ${
        decision === "approve" ? "approved" : "denied"
      }.${emailNotice}`,
      tone: "info",
      ok: true,
      status: 200,
      syncPending: Boolean(command.syncPending || command.body?.syncPending),
    });
  } catch (error) {
    if (Number(error?.status) === 409) {
      const code = String(error?.code || "TOURNEY_DECISION_CONFLICT");
      if (RETRYABLE_DECISION_CONFLICTS.has(code)) {
        return respond({
          title: "Still processing",
          body: "This registration decision is still being processed. Please retry in a few seconds.",
          tone: "info",
          status: 409,
          retryAfter: 5,
          code,
        });
      }
      return respond({
        title: "Decision conflict",
        body: "This registration was already approved or denied.",
        tone: "danger",
        status: 409,
        code,
      });
    }
    logSafeError("Tournament registration decision failed", error);
    if (error?.code === "TOURNEY_WRITES_PAUSED") {
      return respond({
        title: "Try again shortly",
        body: "Tournament updates are briefly paused. Please try again shortly.",
        tone: "danger",
        status: 503,
        retryAfter: error.retryAfter || 30,
        code: "TOURNEY_WRITES_PAUSED",
      });
    }
    return respond({
      title: "Decision failed",
      body: "Unable to update this registration.",
      tone: "danger",
      status: 500,
    });
  }
};

export async function GET(request) {
  const url = new URL(request.url);
  return handleDecision({
    request,
    token: url.searchParams.get("token"),
    decision: String(url.searchParams.get("decision") || "").toLowerCase(),
    approvedRolePlay: String(url.searchParams.get("role") || "").trim(),
    respond: (options) => renderDecisionPage(options),
  });
}

export async function POST(request) {
  if (!isSameOriginMutation(request)) {
    return renderDecisionJson({
      title: "Request rejected",
      body: "Cross-origin request rejected.",
      status: 403,
    });
  }
  let payload;
  try {
    payload = await readBoundedJson(request, { maxBytes: 8 * 1024 });
  } catch (error) {
    return renderDecisionJson({
      title: "Invalid request",
      body: error?.message || "Invalid registration decision request.",
      status: Number(error?.status || 400),
    });
  }
  return handleDecision({
    request,
    token: String(payload.token || "").trim(),
    decision: String(payload.decision || "").trim().toLowerCase(),
    approvedRolePlay: String(payload.role || "").trim(),
    respond: renderDecisionJson,
  });
}
