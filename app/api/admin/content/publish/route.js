import { revalidatePath } from "next/cache";
import { handleCmsRequest } from "../../../../../src/server/cms/http.js";
import { executeGlobalCmsCommand, getCmsCommandStatus } from "../../../../../src/server/cms/publishCommand.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const POST = (request, context) => handleCmsRequest(request, context, async ({ body, client, env, actor }) => {
  const result = await executeGlobalCmsCommand({ body, supabaseClient: client, env, actor });
  if (result.replayed) {
    try { await getCmsCommandStatus({ body, supabaseClient: client, actor }); }
    catch (error) {
      if (error.code === "CMS_NOT_FOUND") return result;
      throw error;
    }
  }
  revalidatePath("/", "layout");
  return result;
}, { write: true });
