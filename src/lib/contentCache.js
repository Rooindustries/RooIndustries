import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import { getPublicContentEntry } from "./publicContentClient";
import { ContentRevisionContext, ContentVisibleContext } from "./ContentRevisionContext";
import { reportRequestError, requestDeadline } from "./clientRequest";

const CONTENT_MAX_AGE_MS = 60 * 1000;

const inBrowser = typeof window !== "undefined";
const snapshotReceivedAt = inBrowser ? Date.now() : 0;
const entries = new Map();
const inflight = new Map();
const listeners = new Map();
let sequence = 0;

const isStale = (receivedAt) => Date.now() - receivedAt > CONTENT_MAX_AGE_MS;

const outranks = (next, current) => {
  if (!current) return true;
  if (next.revision !== null && current.revision !== null && next.revision !== current.revision) {
    return next.revision > current.revision;
  }
  if (next.revision === null && current.revision !== null) return false;
  if (next.revision !== null && current.revision === null) return true;
  return next.sequence >= current.sequence;
};

const notify = (resource) => {
  listeners.get(resource)?.forEach((listener) => listener());
};

const store = (resource, data, revision, requestSequence) => {
  const next = { data, revision, receivedAt: Date.now(), sequence: requestSequence };
  if (!outranks(next, entries.get(resource))) return;
  entries.set(resource, next);
  notify(resource);
};

const seedContent = (resource, data, revision) => {
  const current = entries.get(resource);
  if (!inBrowser || current?.data === data) return;
  const entry = { data, revision, receivedAt: snapshotReceivedAt, sequence: 0 };
  if (!outranks(entry, current)) return;
  entries.set(resource, entry);
  notify(resource);
};

export const loadContent = (resource) => {
  const current = entries.get(resource);
  if (current && !isStale(current.receivedAt)) return Promise.resolve(current.data);
  const pending = inflight.get(resource);
  if (pending) return pending;

  const requestSequence = ++sequence;
  const request = getPublicContentEntry(resource, {}, { cache: "no-cache", signal: requestDeadline() })
    .then(({ data, revision }) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("Public content could not be read.");
      }
      store(resource, data, revision, requestSequence);
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

const subscribe = (resource, listener) => {
  const set = listeners.get(resource) || new Set();
  set.add(listener);
  listeners.set(resource, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(resource);
  };
};

const noEntry = () => undefined;

const shownEntry = (cached, initialData, revision) => {
  if (!cached) return undefined;
  if (initialData === null || cached.data === initialData) return cached;
  return outranks({ revision, sequence: 0 }, cached) ? undefined : cached;
};

export function useContent(resource, initialData = null) {
  const revisions = useContext(ContentRevisionContext);
  const visible = useContext(ContentVisibleContext);
  const snapshotRevision = Number.isSafeInteger(revisions?.[resource]) ? revisions[resource] : null;
  const subscribeToResource = useCallback((listener) => subscribe(resource, listener), [resource]);
  const readEntry = useCallback(() => entries.get(resource), [resource]);
  const cached = useSyncExternalStore(subscribeToResource, readEntry, noEntry);

  useEffect(() => {
    if (initialData !== null) seedContent(resource, initialData, snapshotRevision);
  }, [resource, initialData, snapshotRevision]);

  useEffect(() => {
    if (visible) loadContent(resource).catch(() => {});
  }, [resource, visible]);

  const entry = shownEntry(cached, initialData, snapshotRevision);
  return {
    data: entry ? entry.data : initialData,
  };
}
