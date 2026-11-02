import { revalidatePath } from "next/cache";
import { handleCmsRequest } from "../../../../../../src/server/cms/http.js";
import { getCmsCommandStatus } from "../../../../../../src/server/cms/publishCommand.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

export const POST = (request, context) => handleCmsRequest(request, context, async ({ body, client, actor }) => {
  const result = await getCmsCommandStatus({ body, supabaseClient: client, actor });
  revalidatePath("/", "layout");
  return result;
}, { write: true });
