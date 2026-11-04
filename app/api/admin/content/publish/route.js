import { revalidatePath } from "next/cache";
import { dangerouslyDeleteByTag, invalidateByTag, waitUntil } from "@vercel/functions";
import { handleCmsRequest } from "../../../../../src/server/cms/http.js";
import { executeGlobalCmsCommand } from "../../../../../src/server/cms/publishCommand.js";
import {
  PUBLIC_CONTENT_CACHE_TAG,
  PUBLIC_CONTENT_FIRST_PURGE_WAIT_MS,
  PUBLIC_CONTENT_SECOND_PURGE_DELAY_MS,
} from "../../../../../src/server/content/publicContent.js";
import { logSafeError } from "../../../../../src/server/safeErrorLog.js";

export const runtime = "nodejs";
export const preferredRegion = "dub1";
export const dynamic = "force-dynamic";

const purgePublicContent = async (purge = dangerouslyDeleteByTag) => {
  try {
    await purge(PUBLIC_CONTENT_CACHE_TAG);
  } catch (error) {
    logSafeError("Public content CDN purge failed", error);
  }
};

const delay = (ms) => {
  let timer;
  const done = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
};

const refreshPublicContent = async (committed) => {
  if (committed) waitUntil(delay(PUBLIC_CONTENT_SECOND_PURGE_DELAY_MS).done.then(() => purgePublicContent()));
  const firstPurge = purgePublicContent(committed ? dangerouslyDeleteByTag : invalidateByTag);
  waitUntil(firstPurge);
  revalidatePath("/", "layout");
  const bound = delay(PUBLIC_CONTENT_FIRST_PURGE_WAIT_MS);
  await Promise.race([firstPurge, bound.done]);
  bound.cancel();
};

export const POST = (request, context) => handleCmsRequest(request, context, async ({ request, params, body, client, env, signal, actor }) => {
  let committed = false;
  try {
    const receipt = await executeGlobalCmsCommand({ body, supabaseClient: client, env, actor });
    committed = true;
    return receipt;
  } finally {
    await refreshPublicContent(committed);
  }
}, { write: true });
