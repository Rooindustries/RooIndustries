import { handleCmsRequest } from "../../../../../src/server/cms/http.js";
import { executeGlobalCmsCommand } from "../../../../../src/server/cms/publishCommand.js";
import { refreshPublicContent } from "../../../../../src/server/content/refreshPublicContent.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const POST = (request, context) => handleCmsRequest(request, context, async ({ request, params, body, client, env, signal, actor }) => {
  let committed = false;
  try {
    return await executeGlobalCmsCommand({ body, supabaseClient: client, env, actor, onCommit: () => { committed = true; } });
  } finally {
    await refreshPublicContent(committed);
  }
}, { write: true });
