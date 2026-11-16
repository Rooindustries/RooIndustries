import { dangerouslyDeleteByTag, invalidateByTag, waitUntil } from "@vercel/functions";
import { handleCmsRequest } from "../../../../../src/server/cms/http.js";
import { executeGlobalCmsCommand } from "../../../../../src/server/cms/publishCommand.js";
import {
  PUBLIC_CONTENT_CACHE_TAG,
  PUBLIC_CONTENT_FIRST_PURGE_WAIT_MS,
  PUBLIC_CONTENT_SECOND_PURGE_DELAY_MS,
} from "../../../../../src/server/content/publicContent.js";
import { logSafeError, logSafeEvent } from "../../../../../src/server/safeErrorLog.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGES_CACHE_TAG = "_N_T_/layout";

const LATE_PAGE_MARK_DELAY_MS = 60 * 1000;

const delay = (ms) => {
  let timer;
  const done = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return { done, cancel: () => clearTimeout(timer) };
};

const step = (label, run) => {
  const outcome = Promise.resolve()
    .then(run)
    .then(() => "done", (error) => {
      logSafeError(`${label} failed`, error);
      return "failed";
    });
  waitUntil(outcome);
  return outcome;
};
const purgeContent = (purge) => step("Public content CDN purge", () => purge(PUBLIC_CONTENT_CACHE_TAG));
const markPages = () => step("Public pages mark", () => invalidateByTag(PAGES_CACHE_TAG));
const later = (ms, run) => waitUntil(delay(ms).done.then(run));
const answeredWithin = (label, outcome, reportPending) => {
  const bound = delay(PUBLIC_CONTENT_FIRST_PURGE_WAIT_MS);
  return Promise.race([outcome, bound.done.then(() => "pending")]).then((state) => {
    bound.cancel();
    if (state === "pending" && reportPending) logSafeError(`${label} did not answer in time`, Object.assign(new Error(`${label} did not answer in time.`), { code: "PUBLIC_REFRESH_PENDING" }));
    return state;
  });
};

const refreshRound = (round, purge) => {
  const content = purgeContent(purge);
  const pages = markPages();
  return Promise.all([
    answeredWithin("Public content CDN purge", content, round === "now"),
    answeredWithin("Public pages mark", pages, round === "now"),
  ]).then(([contentState, pagesState]) => {
    logSafeEvent("public_pages_refresh", {
      round,
      pages: pagesState === "done" ? "marked" : pagesState,
      content: contentState === "done" ? "purged" : contentState,
    });
    return { content: contentState, pages: pagesState };
  });
};

const refreshPublicContent = (committed) => {
  const first = refreshRound("now", committed ? dangerouslyDeleteByTag : invalidateByTag);
  if (committed) {
    later(PUBLIC_CONTENT_SECOND_PURGE_DELAY_MS, () => refreshRound("5s", dangerouslyDeleteByTag));
    later(LATE_PAGE_MARK_DELAY_MS, () => refreshRound("60s", dangerouslyDeleteByTag));
  }
  return first;
};

export const POST = (request, context) => handleCmsRequest(request, context, async ({ request, params, body, client, env, signal, actor }) => {
  let committed = false;
  let result;
  try {
    result = await executeGlobalCmsCommand({ body, supabaseClient: client, env, actor, onCommit: () => { committed = true; } });
  } finally {
    const refresh = await refreshPublicContent(committed);
    if (result) result = { ...result, refresh };
  }
  return result;
}, { write: true });
