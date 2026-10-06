const PREFIX = "roo-content-draft:v1:";

const storage = () => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export const draftKey = ({ documentId, type, createIntentId }) =>
  documentId ? `${PREFIX}doc:${documentId}` : `${PREFIX}new:${type}:${createIntentId}`;

export const saveDraft = (key, draft) => {
  try {
    const store = storage();
    if (!store) return false;
    store.setItem(key, JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
};

export const readDraft = (key) => {
  try {
    const raw = storage()?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && parsed.document ? parsed : null;
  } catch {
    return null;
  }
};

export const clearDraft = (key) => {
  try {
    storage()?.removeItem(key);
  } catch {
    return undefined;
  }
  return undefined;
};

export const listNewDrafts = (type) => {
  const store = storage();
  if (!store) return [];
  const drafts = [];
  for (let index = 0; index < store.length; index += 1) {
    const key = store.key(index);
    if (!key?.startsWith(`${PREFIX}new:${type}:`)) continue;
    const draft = readDraft(key);
    if (draft?.createIntentId) drafts.push({ key, ...draft });
  }
  return drafts.sort((left, right) => String(right.savedAt).localeCompare(String(left.savedAt)));
};
