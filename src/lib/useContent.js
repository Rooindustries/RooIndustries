import { useCallback, useContext, useEffect, useSyncExternalStore } from "react";
import { ContentRevisionContext, ContentVisibleContext } from "./ContentRevisionContext";
import { loadContent, writeContent, subscribe, readContent, outranks } from "./contentCache";

const noEntry = () => undefined;

const seedContent = (resource, data, revision, renderedAt) => {
  if (readContent(resource)?.data === data) return;
  const receivedAt = revision === null ? 0 : renderedAt;
  writeContent(resource, data, revision, 0, receivedAt);
};

const shownEntry = (cached, initialData, revision) => {
  if (!cached) return undefined;
  if (initialData === null || cached.data === initialData) return cached;
  return outranks({ revision, sequence: 0 }, cached) ? undefined : cached;
};

export function useContent(resource, initialData = null, { enabled = true } = {}) {
  const snapshot = useContext(ContentRevisionContext);
  const visible = useContext(ContentVisibleContext);
  const revision = snapshot?.revisions?.[resource];
  const snapshotRevision = Number.isSafeInteger(revision) ? revision : null;
  const renderedAt = snapshot?.renderedAt ?? 0;
  const subscribeToResource = useCallback((listener) => subscribe(resource, listener), [resource]);
  const readEntry = useCallback(() => readContent(resource), [resource]);
  const cached = useSyncExternalStore(subscribeToResource, readEntry, noEntry);

  useEffect(() => {
    if (initialData !== null) seedContent(resource, initialData, snapshotRevision, renderedAt);
  }, [resource, initialData, snapshotRevision, renderedAt]);

  useEffect(() => {
    if (enabled && visible) loadContent(resource).catch(() => {});
  }, [resource, enabled, visible]);

  const entry = shownEntry(cached, initialData, snapshotRevision);
  return {
    data: entry ? entry.data : initialData,
  };
}
