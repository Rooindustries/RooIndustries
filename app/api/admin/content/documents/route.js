import { handleCmsRequest } from "../../../../../src/server/cms/http.js";
import { listContentDocuments } from "../../../../../src/server/cms/documents.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const GET = (request, context) => handleCmsRequest(request, context, ({ request, params, body, client, env, signal }) => listContentDocuments(client, new URL(request.url).searchParams.get("type")), {});
