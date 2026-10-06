import { handleCmsRequest } from "../../../../../../src/server/cms/http.js";
import { issueCmsUpload } from "../../../../../../src/server/cms/assets.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const POST = (request, context) => handleCmsRequest(request, context, ({ body, client, env, actor }) => issueCmsUpload({ body, client, env, actor }), { write: true });
