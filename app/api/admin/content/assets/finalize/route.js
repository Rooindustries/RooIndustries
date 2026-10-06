import { handleCmsRequest } from "../../../../../../src/server/cms/http.js";
import { finalizeCmsUpload } from "../../../../../../src/server/cms/assets.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = (request, context) => handleCmsRequest(request, context, ({ request, params, body, client, env, signal }) => finalizeCmsUpload({ body, client, env, signal }), { write: true, timeoutMs: 240000 });
