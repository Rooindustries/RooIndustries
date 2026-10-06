import { handleCmsRequest } from "../../../../../../src/server/cms/http.js";
import { getContentDocument } from "../../../../../../src/server/cms/documents.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const GET = (request, context) => handleCmsRequest(request, context, ({ request, params, body, client, env, signal }) => getContentDocument(client, params.id), {});
