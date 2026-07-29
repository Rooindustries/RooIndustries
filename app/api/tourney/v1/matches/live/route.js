import {
  buildPublicLiveResponse,
  readPublicBracketApiSnapshot,
} from "../../../../../../src/server/tourney/publicBracketApi";
import {
  publicApiError,
  publicApiJson,
  publicApiOptions,
} from "../../../../../../src/server/tourney/publicApiResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const limit = Number(searchParams.get("limit") || 3);
  if (!Number.isFinite(limit)) {
    return publicApiError("Limit must be a number from 1 to 10.", 400);
  }
  const matchId = String(searchParams.get("match") || "")
    .trim()
    .slice(0, 120);
  const team = String(searchParams.get("team") || "")
    .trim()
    .slice(0, 120);

  try {
    const snapshot = await readPublicBracketApiSnapshot();
    return publicApiJson(
      buildPublicLiveResponse(snapshot, { limit, matchId, team })
    );
  } catch {
    return publicApiError("Bracket data is temporarily unavailable.", 503);
  }
}

export async function OPTIONS() {
  return publicApiOptions();
}
