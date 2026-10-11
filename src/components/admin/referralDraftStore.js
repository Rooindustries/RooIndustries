const PREFIX = "roo-referral-draft:v1:";
const creatorPrefix = (creatorId) => `${PREFIX}${encodeURIComponent(creatorId)}:`;
const key = (creatorId, baseVersion) => `${creatorPrefix(creatorId)}${baseVersion}`;

const validDraft = (draft) => draft && typeof draft === "object" &&
  ["totalPercent", "commissionPercent", "discountPercent", "reason"].every(field => typeof draft[field] === "string") &&
  typeof draft.bypassUnlock === "boolean" && Object.keys(draft).length === 5;

const collectDrafts = (store, creatorId) => {
  const drafts = [];
  let invalid = false;
  const keys = Array.from({ length: store.length }, (_, index) => store.key(index)).filter(storedKey => storedKey?.startsWith(creatorPrefix(creatorId)));
  for (const storedKey of keys) {
    let saved;
    try { saved = JSON.parse(store.getItem(storedKey)); } catch { saved = null; }
    if (saved?.schema !== 1 || saved.creatorId !== creatorId || !Number.isSafeInteger(saved.baseVersion) || saved.baseVersion < 1 || storedKey !== key(saved.creatorId, saved.baseVersion) || !validDraft(saved.draft) || !Number.isFinite(Date.parse(saved.savedAt))) {
      store.removeItem(storedKey);
      invalid = true;
    } else {
      drafts.push(saved);
    }
  }
  return { drafts, invalid };
};

export const readReferralDraft = (creator) => {
  try {
    const { drafts, invalid } = collectDrafts(window.localStorage, creator.creator_id);
    const saved = drafts.find(draft => draft.baseVersion === creator.terms_version) || drafts.sort((left, right) => Date.parse(right.savedAt) - Date.parse(left.savedAt))[0];
    return saved ? { ...saved, stale: saved.baseVersion !== creator.terms_version } : invalid ? { invalid: true } : null;
  } catch {
    return { unavailable: true };
  }
};

export const saveReferralDraft = (creatorId, baseVersion, draft) => {
  try {
    const store = window.localStorage;
    const savedKey = key(creatorId, baseVersion);
    store.setItem(savedKey, JSON.stringify({ schema: 1, creatorId, baseVersion, draft, savedAt: new Date().toISOString() }));
    collectDrafts(store, creatorId);
    return true;
  } catch {
    return false;
  }
};

export const clearReferralDrafts = (creatorId, baseVersion) => {
  try {
    const store = window.localStorage;
    store.removeItem(key(creatorId, baseVersion));
    collectDrafts(store, creatorId);
    return true;
  } catch {
    return false;
  }
};
