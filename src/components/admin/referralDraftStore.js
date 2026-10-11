const PREFIX = "roo-referral-draft:v1:";
const creatorPrefix = (creatorId) => `${PREFIX}${encodeURIComponent(creatorId)}:`;
const key = (creatorId, baseVersion) => `${creatorPrefix(creatorId)}${baseVersion}`;

const validDraft = (draft) => draft && typeof draft === "object" &&
  ["totalPercent", "commissionPercent", "discountPercent", "reason"].every(field => typeof draft[field] === "string") &&
  typeof draft.bypassUnlock === "boolean" && Object.keys(draft).length === 5;

export const readReferralDraft = (creator) => {
  try {
    const store = window.localStorage;
    const drafts = [];
    for (let index = 0; index < store.length; index += 1) {
      const storedKey = store.key(index);
      if (!storedKey?.startsWith(creatorPrefix(creator.creator_id))) continue;
      let saved;
      try { saved = JSON.parse(store.getItem(storedKey)); }
      catch { return { invalid: true }; }
      if (saved?.schema !== 1 || saved.creatorId !== creator.creator_id || !Number.isSafeInteger(saved.baseVersion) || saved.baseVersion < 1 || storedKey !== key(saved.creatorId, saved.baseVersion) || !validDraft(saved.draft) || !Number.isFinite(Date.parse(saved.savedAt))) {
        return { invalid: true };
      }
      drafts.push(saved);
    }
    const saved = drafts.sort((left, right) => right.savedAt.localeCompare(left.savedAt))[0];
    return saved ? { ...saved, stale: saved.baseVersion !== creator.terms_version } : null;
  } catch {
    return { unavailable: true };
  }
};

export const saveReferralDraft = (creatorId, baseVersion, draft) => {
  try {
    const store = window.localStorage;
    const savedKey = key(creatorId, baseVersion);
    store.setItem(savedKey, JSON.stringify({ schema: 1, creatorId, baseVersion, draft, savedAt: new Date().toISOString() }));
    const previousKeys = Array.from({ length: store.length }, (_, index) => store.key(index)).filter(storedKey => storedKey !== savedKey && storedKey?.startsWith(creatorPrefix(creatorId)));
    previousKeys.forEach(storedKey => store.removeItem(storedKey));
    return true;
  } catch {
    return false;
  }
};

export const clearReferralDrafts = (creatorId) => {
  try {
    const store = window.localStorage;
    const keys = Array.from({ length: store.length }, (_, index) => store.key(index)).filter(storedKey => storedKey?.startsWith(creatorPrefix(creatorId)));
    keys.forEach(storedKey => store.removeItem(storedKey));
    return true;
  } catch {
    return false;
  }
};
