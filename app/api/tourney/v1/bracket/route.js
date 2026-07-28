import {
  buildPublicBracketResponse,
  readPublicBracketApiSnapshot,
} from "../../../../../src/server/tourney/publicBracketApi";
import {
  publicApiError,
  publicApiJson,
  publicApiOptions,
} from "../../../../../src/server/tourney/publicApiResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await readPublicBracketApiSnapshot();
    return publicApiJson(buildPublicBracketResponse(snapshot));
  } catch {
    return publicApiError("Bracket data is temporarily unavailable.", 503);
  }
}

export async function OPTIONS() {
  return publicApiOptions();
}
