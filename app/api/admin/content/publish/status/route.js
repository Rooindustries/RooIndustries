import { handleCmsRequest } from "../../../../../../src/server/cms/http.js";
import { getCreateCommandStatus } from "../../../../../../src/server/cms/publishCommand.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const POST = (request, context) => handleCmsRequest(request, context, ({ body, client, actor }) => getCreateCommandStatus({ body, supabaseClient: client, actor }), { write: true });
