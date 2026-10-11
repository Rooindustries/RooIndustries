import { handleCmsRequest } from "../../../../../src/server/cms/http.js";
import { executeGlobalCmsCommand, getCreateIntentDocument } from "../../../../../src/server/cms/publishCommand.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const GET = (request, context) => handleCmsRequest(request, context, ({ client }) => {
  const parameters = new URL(request.url).searchParams;
  return getCreateIntentDocument({ type: parameters.get("type"), createIntentId: parameters.get("createIntentId"), client });
});

export const POST = (request, context) => handleCmsRequest(request, context, ({ request, params, body, client, env, signal, actor }) => executeGlobalCmsCommand({ body, supabaseClient: client, env, actor }), { write: true });
