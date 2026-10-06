import { handleCmsRequest } from "../../../../../../src/server/cms/http.js";
import { finalizeCmsUpload } from "../../../../../../src/server/cms/assets.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const POST = (request, context) => handleCmsRequest(request, context, ({ body, client, env, signal, actor }) => finalizeCmsUpload({ body, client, env, signal, actor }), { write: true, timeoutMs: 240000 });
