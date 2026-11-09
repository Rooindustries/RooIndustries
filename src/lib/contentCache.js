import { normalizeContent } from "./normalizeContent";
import { contentEntries as entries } from "./contentEntries";
import { getPublicContentEntry } from "./publicContentClient";
import { reportRequestError, requestDeadline } from "./clientRequest";
import { homeSectionResources } from "./homeSectionKeys";

const CONTENT_MAX_AGE_MS = 60 * 1000;
const SESSION_MAX_AGE_MS = 5 * 60 * 1000;
const SESSION_PREFIX = "roo-home-copy:";

const inflight = new Map();
const listeners = new Map();
let sequence = 0;

const LIST_RESOURCES = new Set(["benchmarks", "tools", "reviews-gallery", "faq-questions", "packages-list"]);

const matchesContentType = (resource, data) => {
  if (data === null) return !LIST_RESOURCES.has(resource);
  const isList = Array.isArray(data);
  return LIST_RESOURCES.has(resource) ? isList : typeof data === "object" && !isList;
};

const isStale = (receivedAt) => Date.now() - receivedAt > CONTENT_MAX_AGE_MS;

export const outranks = (next, current) =>
  !current || (next.revision ?? -1) > (current.revision ?? -1) ||
  (next.revision === current.revision && next.sequence >= current.sequence);

const notify = (resource) => {
  listeners.get(resource)?.forEach((listener) => listener());
};

export const writeContent = (resource, data, revision, requestSequence, receivedAt = Date.now()) => {
  const next = { data, revision, receivedAt, sequence: requestSequence };
  if (!outranks(next, entries.get(resource))) return;
  entries.set(resource, next);
  if (typeof window !== "undefined" && homeSectionResources.has(resource)) {
    try { sessionStorage.setItem(SESSION_PREFIX + resource, JSON.stringify(next)); } catch {}
  }
  notify(resource);
};

export const restoreContent = (resource) => {
  if (typeof window === "undefined" || !homeSectionResources.has(resource) || entries.has(resource)) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_PREFIX + resource));
    if (!saved || !Number.isFinite(saved.receivedAt) || Date.now() - saved.receivedAt > SESSION_MAX_AGE_MS ||
        !matchesContentType(resource, saved.data)) return;
    entries.set(resource, { ...saved, sequence: 0 });
    notify(resource);
  } catch {}
};

export const loadContent = (resource) => {
  restoreContent(resource);
  const current = entries.get(resource);
  if (current && !isStale(current.receivedAt)) return Promise.resolve(current.data);
  const pending = inflight.get(resource);
  if (pending) return pending;

  const requestSequence = ++sequence;
  const request = getPublicContentEntry(resource, {}, { cache: "no-cache", signal: requestDeadline() })
    .then(({ data, revision }) => {
      if (!matchesContentType(resource, data)) throw new Error("Public content could not be read.");
      writeContent(resource, data === null ? null : normalizeContent(resource, data), revision, requestSequence);
      return entries.get(resource).data;
    })
    .catch((error) => {
      reportRequestError(error);
      const kept = entries.get(resource);
      if (kept) return kept.data;
      throw error;
    })
    .finally(() => {
      if (inflight.get(resource) === request) inflight.delete(resource);
    });
  inflight.set(resource, request);
  return request;
};

export const subscribe = (resource, listener) => {
  const set = listeners.get(resource) || new Set();
  set.add(listener);
  listeners.set(resource, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(resource);
  };
};

export const readContent = (resource) => entries.get(resource);
