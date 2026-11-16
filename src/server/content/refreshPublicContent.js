import { revalidatePath } from 'next/cache';
import { dangerouslyDeleteByTag, invalidateByTag, waitUntil } from '@vercel/functions';
import {
  PUBLIC_CONTENT_CACHE_TAG,
  PUBLIC_CONTENT_FIRST_PURGE_WAIT_MS,
  PUBLIC_CONTENT_SECOND_PURGE_DELAY_MS,
} from './publicContent.js';
import { logSafeError } from '../safeErrorLog.js';

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

export const refreshPublicContent = async (committed) => {
  if (committed) waitUntil(delay(PUBLIC_CONTENT_SECOND_PURGE_DELAY_MS).done.then(() => purgePublicContent()));
  const firstPurge = purgePublicContent(committed ? dangerouslyDeleteByTag : invalidateByTag);
  waitUntil(firstPurge);
  revalidatePath("/", "layout");
  const bound = delay(PUBLIC_CONTENT_FIRST_PURGE_WAIT_MS);
  await Promise.race([firstPurge, bound.done]);
  bound.cancel();
};
