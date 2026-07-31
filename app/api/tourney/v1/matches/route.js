import {
  buildPublicMatchesResponse,
  normalizeGroupFilter,
  parseStatusFilter,
  readPublicBracketApiSnapshot,
} from "../../../../../src/server/tourney/publicBracketApi";
import {
  publicApiError,
  publicApiJson,
  publicApiOptions,
} from "../../../../../src/server/tourney/publicApiResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const status = parseStatusFilter(searchParams.get("status"));
  if (!status.ok) {
    return publicApiError(
      "Unsupported status filter. Use locked, waiting, ready, running, completed, archived, or cancelled.",
      400
    );
  }
  const group = normalizeGroupFilter(searchParams.get("group"));
  if (!group.ok) {
    return publicApiError(
      "Unsupported group filter. Use winners, losers, or grand-final.",
      400
    );
  }

  try {
    const snapshot = await readPublicBracketApiSnapshot();
    return publicApiJson(
      buildPublicMatchesResponse(snapshot, {
        statusCodes: status.codes,
        groupName: group.groupName,
      })
    );
  } catch {
    return publicApiError("Bracket data is temporarily unavailable.", 503);
  }
}

export async function OPTIONS() {
  return publicApiOptions();
}
