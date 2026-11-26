import { CONSENT_KEY, DECLINED_KEY, STORAGES } from "./consentSignals";
import { CHOICES, keepUnsaved, readConsent } from "./consentChoice";
import { normalizeLinkReferral } from "./refShape.js";

export const CONSENT_EPOCH_KEY = "roo-consent-epoch";
const FIRST_COOKIE = "roo_attr";
const LAST_COOKIE = "roo_attr_last";
const SESSION_KEY = "sales_attribution";
const COOKIE_LOCK = "roo_sales_attribution_cookie";
const STATE_LOCK = "roo_consent_state_lock";
const CHANNEL_NAME = "roo_sales_attribution_sync";
const TAB_PREFIX = "roo_attr_tab:";
const PEER_WAIT_MS = 250;
const COOKIE_MAX_AGE = 7776000;
const ALL_COOKIES = [FIRST_COOKIE, LAST_COOKIE, "_fbp", "_fbc"];

let memory = null;
let pendingWrite = null;
let pendingWriteSeq = 0;
let unsavedFallback = null;
let tabId = "";
let presenceStarted = false;
let hiding = false;
let releasePresence = null;
let channel = null;
let syncWired = false;
let thawQueued = false;
const handlers = new Set();
const contributed = new Map();

export const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const decode = (text) => {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
};

const encode = (value) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(JSON.stringify(value))) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const readCookie = (name) => {
  const prefix = `${name}=`;
  try {
    const entry = document.cookie.split(/;\s*/).find((part) => part.startsWith(prefix));
    return entry ? entry.slice(prefix.length) : "";
  } catch {
    return "";
  }
};

const readCookieValue = (name) => {
  try {
    const encoded = readCookie(name);
    return encoded ? decode(encoded) : null;
  } catch {
    return null;
  }
};

const ms = (touch) =>
  isRecord(touch) && typeof touch.capturedAt === "string" ? Date.parse(touch.capturedAt) : NaN;

const cleanStoredTouch = (raw) => {
  if (!isRecord(raw) || typeof raw.capturedAt !== "string") return null;
  if (!Number.isFinite(Date.parse(raw.capturedAt))) return null;
  const { version: _v, journeyId: _j, ...rest } = raw;
  if (Object.hasOwn(rest, "creatorCode")) {
    const safe = normalizeLinkReferral(rest.creatorCode);
    if (safe) {
      rest.creatorCode = safe;
    } else {
      delete rest.creatorCode;
    }
  }
  return rest;
};

const normalizeStoredJourney = (value) => {
  if (!isRecord(value) || typeof value.journeyId !== "string" || !value.journeyId) return null;
  if (value.version === 1) {
    const touch = cleanStoredTouch(value);
    if (!touch) return null;
    return {
      version: 2,
      journeyId: value.journeyId,
      firstTouch: touch,
      lastTouch: { ...touch },
    };
  }
  if (value.version !== undefined && value.version !== 2) return null;
  const first = cleanStoredTouch(value.firstTouch);
  const last = cleanStoredTouch(value.lastTouch);
  if (!first && !last) return null;
  return {
    version: 2,
    journeyId: value.journeyId,
    firstTouch: first || { ...last },
    lastTouch: last || { ...first },
  };
};

const readSessionRaw = () => {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return normalizeStoredJourney(parsed);
  } catch {
    return null;
  }
};

const writeSessionRaw = (value) => {
  try {
    if (!value) {
      sessionStorage.removeItem(SESSION_KEY);
      return true;
    }
    const serialized = JSON.stringify(value);
    if (sessionStorage.getItem(SESSION_KEY) !== serialized) {
      sessionStorage.setItem(SESSION_KEY, serialized);
    }
    return true;
  } catch {
    return false;
  }
};

const readCookiesRaw = () => {
  const first = readCookieValue(FIRST_COOKIE);
  if (!isRecord(first)) return null;
  const last = readCookieValue(LAST_COOKIE);
  const combined =
    isRecord(last) && last.journeyId === first.journeyId
      ? { ...first, lastTouch: last.lastTouch }
      : first;
  return normalizeStoredJourney(combined);
};

const readLiveSharedConsent = () => {
  try {
    const value = localStorage.getItem(CONSENT_KEY);
    return value === "granted" || value === "denied" ? value : "unset";
  } catch {
    return "unset";
  }
};

const cookiesAllowed = () =>
  readConsent() === "granted" && readLiveSharedConsent() === "granted";

const mergeAttributionMonotonic = (primary, secondary) => {
  const a = normalizeStoredJourney(primary);
  const b = normalizeStoredJourney(secondary);
  if (!a && !b) return null;
  if (!a || !b) {
    const src = a || b;
    return {
      version: 2,
      journeyId: src.journeyId,
      firstTouch: { ...src.firstTouch },
      lastTouch: { ...src.lastTouch },
    };
  }
  const af = a.firstTouch;
  const al = a.lastTouch;
  const bf = b.firstTouch;
  const bl = b.lastTouch;
  const pickBf = Number.isFinite(ms(bf)) && (!Number.isFinite(ms(af)) || ms(bf) < ms(af));
  const pickBl = Number.isFinite(ms(bl)) && (!Number.isFinite(ms(al)) || ms(bl) > ms(al));
  return {
    version: 2,
    journeyId: pickBf ? b.journeyId : a.journeyId,
    firstTouch: { ...(pickBf ? bf : af) },
    lastTouch: { ...(pickBl ? bl : al) },
  };
};

const setCookie = (name, value, maxAge, domain = "") => {
  const scope = domain ? `; Domain=${domain}` : "";
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  try {
    document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAge}${scope}; SameSite=Lax${secure}`;
  } catch {}
};

const writeCookiesRaw = ({ lastTouch, ...first }) => {
  const pairs = [
    [FIRST_COOKIE, encode(first)],
    [LAST_COOKIE, encode({ journeyId: first.journeyId, lastTouch })],
  ];
  for (const [name, encoded] of pairs) {
    if (readCookie(name) !== encoded) {
      setCookie(name, encoded, COOKIE_MAX_AGE);
    }
  }
  return pairs.every(([name, encoded]) => readCookie(name) === encoded);
};

const removeCookies = (names = ALL_COOKIES) => {
  const labels = window.location.hostname.split(".");
  const domains = ["", ...labels.slice(0, -1).map((_, idx) => labels.slice(idx).join("."))];
  for (const name of names) {
    if (!readCookie(name)) continue;
    for (const domain of domains) {
      setCookie(name, "", 0, domain);
    }
  }
};

const makeId = () => {
  if (typeof window !== "undefined" && window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const getTabId = () => {
  if (!tabId) tabId = makeId();
  return tabId;
};

const hasLocks = () =>
  typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";

const ensurePresence = () => {
  if (presenceStarted || hiding || typeof window === "undefined") return;
  presenceStarted = true;
  if (!hasLocks()) return;
  try {
    navigator.locks
      .request(`${TAB_PREFIX}${getTabId()}`, () =>
        hiding
          ? undefined
          : new Promise((resolve) => {
              releasePresence = resolve;
            }),
      )
      .catch(() => {});
  } catch {}
};

const withLock = (name, fn, onLockUnavailable = null) => {
  ensurePresence();
  if (!hasLocks()) return Promise.resolve().then(fn);
  let started = false;
  const invoke = () => {
    started = true;
    return fn();
  };
  try {
    return navigator.locks.request(name, invoke).catch((error) => {
      if (!started && onLockUnavailable) return onLockUnavailable(error);
      throw error;
    });
  } catch (error) {
    if (!started && onLockUnavailable) {
      return Promise.resolve().then(() => onLockUnavailable(error));
    }
    return Promise.reject(error);
  }
};

const withBothLocks = (fn) => {
  let entered = false;
  const runOnce = () => {
    if (entered) return undefined;
    entered = true;
    return fn();
  };
  return withLock(COOKIE_LOCK, () => withLock(STATE_LOCK, runOnce, runOnce), runOnce);
};

const touchMs = (attribution) => {
  const normalized = normalizeStoredJourney(attribution);
  const capturedAt = normalized?.lastTouch?.capturedAt;
  return typeof capturedAt === "string" ? Date.parse(capturedAt) : NaN;
};

const readEpoch = () => {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CONSENT_EPOCH_KEY) || "null");
    if (!isRecord(parsed)) return 0;
    const prev = Number.isInteger(parsed.prevEpoch) && parsed.prevEpoch >= 0 ? parsed.prevEpoch : 0;
    const matched =
      readLiveSharedConsent() === parsed.nextChoice &&
      Number.isInteger(parsed.nextEpoch) &&
      parsed.nextEpoch >= 0;
    return matched ? parsed.nextEpoch : prev;
  } catch {
    return 0;
  }
};

const writeSharedChoice = (goal) => {
  try {
    if (goal === "unset") {
      window.localStorage.removeItem(CONSENT_KEY);
    } else {
      window.localStorage.setItem(CONSENT_KEY, goal);
    }
    return true;
  } catch {
    return false;
  }
};

const restoreEpochRaw = (prevRaw) => {
  try {
    if (prevRaw === null) {
      window.localStorage.removeItem(CONSENT_EPOCH_KEY);
    } else {
      window.localStorage.setItem(CONSENT_EPOCH_KEY, prevRaw);
    }
  } catch {}
};

const commitSharedTransition = (target) => {
  const goal = CHOICES.has(target) ? target : "unset";
  const cur = readEpoch();
  if (readLiveSharedConsent() === goal) {
    return { ok: true, changed: false, epoch: cur, goal };
  }
  const nextEpochPayload = JSON.stringify({
    prevEpoch: cur,
    nextEpoch: cur + 1,
    nextChoice: goal,
  });
  let prevEpochRaw = null;
  let epochStaged = false;
  try {
    prevEpochRaw = window.localStorage.getItem(CONSENT_EPOCH_KEY);
    window.localStorage.setItem(CONSENT_EPOCH_KEY, nextEpochPayload);
    epochStaged = true;
  } catch {
    if (goal !== "unset" || prevEpochRaw !== null) {
      return { ok: false, changed: false, epoch: cur, goal };
    }
  }
  if (!writeSharedChoice(goal)) {
    if (epochStaged) restoreEpochRaw(prevEpochRaw);
    return { ok: false, changed: false, epoch: cur, goal };
  }
  if (!epochStaged) {
    try {
      window.localStorage.setItem(CONSENT_EPOCH_KEY, nextEpochPayload);
      return { ok: true, changed: true, epoch: cur + 1, goal };
    } catch {
      return { ok: true, changed: true, epoch: cur, goal };
    }
  }
  return { ok: true, changed: true, epoch: cur + 1, goal };
};

const discoverPeers = async () => {
  ensurePresence();
  const peers = new Set();
  if (!navigator.locks?.query) return peers;
  try {
    const self = `${TAB_PREFIX}${getTabId()}`;
    const state = await navigator.locks.query();
    for (const lock of state.held || []) {
      const name = String(lock?.name || "");
      if (name.startsWith(TAB_PREFIX) && name !== self) {
        peers.add(name.slice(TAB_PREFIX.length));
      }
    }
  } catch {}
  return peers;
};

const getChannel = () => {
  if (typeof window === "undefined" || typeof window.BroadcastChannel !== "function") {
    return null;
  }
  if (!channel) {
    channel = new window.BroadcastChannel(CHANNEL_NAME);
    channel.addEventListener("message", (event) => {
      if (!isRecord(event?.data)) return;
      for (const handler of [...handlers]) {
        try {
          handler(event.data);
        } catch {}
      }
    });
  }
  return channel;
};

const postMsg = (msg) => {
  const ch = getChannel();
  if (!ch) return;
  try {
    ch.postMessage(msg);
  } catch {}
};

const waitPeers = (expectedPeers, type, reqId) => {
  const left = new Set(expectedPeers);
  const out = [];
  if (!left.size || !getChannel()) return Promise.resolve(out);
  return new Promise((resolve) => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      handlers.delete(onMsg);
      resolve(out);
    };
    const onMsg = (msg) => {
      const pid = msg.type === type && msg.requestId === reqId && msg.tabId ? String(msg.tabId) : "";
      if (!pid) return;
      out.push(msg);
      left.delete(pid);
      if (!left.size) finish();
    };
    handlers.add(onMsg);
    timer = setTimeout(finish, PEER_WAIT_MS);
  });
};

const readLocalSession = () => {
  const overlay =
    mergeAttributionMonotonic(pendingWrite, unsavedFallback) || pendingWrite || unsavedFallback;
  const session = readSessionRaw();
  return mergeAttributionMonotonic(session, overlay) || session || overlay;
};

const handlePeerMessage = (msg) => {
  const type = String(msg.type || "");
  if (type === "collect_session_attribution" && msg.requestId) {
    withLock(STATE_LOCK, () => {
      const own = readLocalSession();
      const capturedAt = typeof own?.lastTouch?.capturedAt === "string" ? own.lastTouch.capturedAt : "";
      contributed.set(String(msg.requestId), capturedAt);
      postMsg({
        type: "session_attribution_reply",
        requestId: String(msg.requestId),
        tabId: getTabId(),
        attribution: own,
      });
    }).catch(() => {});
    return;
  }
  if (type === "session_attribution_promoted") {
    withLock(STATE_LOCK, () => {
      const epoch = readEpoch();
      if (
        readLiveSharedConsent() !== "granted" ||
        msg.targetConsent !== "granted" ||
        msg.consentEpoch !== epoch
      ) {
        return;
      }
      const myId = getTabId();
      const reqId = typeof msg.requestId === "string" ? msg.requestId : "";
      if (Array.isArray(msg.peerIds) && !msg.peerIds.includes(myId)) {
        if (reqId) contributed.delete(reqId);
        return;
      }
      if (reqId && !contributed.has(reqId)) return;
      const own = readLocalSession();
      const curMs = touchMs(own);
      const byPeer = isRecord(msg.collectedCapturedAtByPeer) ? msg.collectedCapturedAtByPeer : null;
      const refCap =
        (reqId ? contributed.get(reqId) : "") ||
        (byPeer && typeof byPeer[myId] === "string" ? String(byPeer[myId]) : "") ||
        (typeof msg.collectedCapturedAt === "string" ? msg.collectedCapturedAt : "");
      const refMs = refCap ? Date.parse(refCap) : NaN;
      if (Number.isFinite(curMs) && (!Number.isFinite(refMs) || curMs > refMs)) return;
      if (reqId) contributed.delete(reqId);
      unsavedFallback = null;
      if (readSessionRaw()) writeSessionRaw(null);
      postMsg({
        type: "session_attribution_promoted_ack",
        requestId: reqId,
        tabId: myId,
        consentEpoch: epoch,
      });
    }).catch(() => {});
    return;
  }
  if (type === "sync_declined_attribution") {
    withLock(STATE_LOCK, () => {
      const live = readLiveSharedConsent();
      const epoch = readEpoch();
      if (live === "granted" || msg.targetConsent !== live || msg.consentEpoch !== epoch) return;
      const incoming = isRecord(msg.attribution) ? msg.attribution : null;
      const merged = mergeAttributionMonotonic(readLocalSession(), incoming);
      if (merged) {
        rememberMerged(merged);
        if (!writeSessionRaw(merged)) {
          unsavedFallback = mergeAttributionMonotonic(merged, unsavedFallback) || merged;
          return;
        }
        unsavedFallback = null;
      }
      postMsg({
        type: "sync_declined_ack",
        requestId: String(msg.requestId || ""),
        tabId: getTabId(),
        consentEpoch: epoch,
      });
    }).catch(() => {});
  }
};

export const ensureAttributionSync = () => {
  if (syncWired || typeof window === "undefined") return;
  syncWired = true;
  window.addEventListener("pagehide", () => {
    hiding = true;
    presenceStarted = false;
    releasePresence?.();
    releasePresence = null;
    channel?.close();
    channel = null;
  });
  window.addEventListener("pageshow", (event) => {
    hiding = false;
    if (event.persisted) {
      ensurePresence();
      getChannel();
    }
  });
  ensurePresence();
  getChannel();
  handlers.add(handlePeerMessage);
};

const runWriteSync = (value, onMerged) => {
  ensureAttributionSync();
  if (cookiesAllowed()) {
    const existing = mergeAttributionMonotonic(
      mergeAttributionMonotonic(readCookiesRaw(), readSessionRaw()),
      unsavedFallback,
    );
    const merged = mergeAttributionMonotonic(value, existing);
    if (!merged) return;
    onMerged?.(merged);
    if (writeCookiesRaw(merged)) {
      unsavedFallback = null;
      writeSessionRaw(null);
    } else {
      saveSessionOrFallback(merged);
    }
    return;
  }
  const merged = mergeAttributionMonotonic(
    value,
    mergeAttributionMonotonic(readSessionRaw(), unsavedFallback),
  );
  if (!merged) return;
  onMerged?.(merged);
  saveSessionOrFallback(merged);
};

const runQueueThawPromotion = (onMerged) => {
  ensureAttributionSync();
  if (thawQueued) return Promise.resolve();
  thawQueued = true;
  return withBothLocks(() => {
    if (!cookiesAllowed()) return;
    const session = mergeAttributionMonotonic(readSessionRaw(), unsavedFallback);
    const merged = session ? mergeAttributionMonotonic(readCookiesRaw(), session) : null;
    if (!merged) return;
    onMerged?.(merged);
    if (!writeCookiesRaw(merged)) return;
    unsavedFallback = null;
    const currentMs = touchMs(readSessionRaw());
    const mergedMs = touchMs(merged);
    if (!Number.isFinite(currentMs) || !Number.isFinite(mergedMs) || currentMs <= mergedMs) {
      writeSessionRaw(null);
    }
  })
    .catch(() => {})
    .finally(() => {
      thawQueued = false;
    });
};

const rememberMerged = (merged) => {
  memory = mergeAttributionMonotonic(merged, memory) || merged;
};

const saveSessionOrFallback = (merged) => {
  if (!merged) return true;
  rememberMerged(merged);
  if (writeSessionRaw(merged)) {
    unsavedFallback = null;
    return true;
  }
  unsavedFallback = mergeAttributionMonotonic(merged, unsavedFallback) || merged;
  return false;
};

export const readStoredAttribution = () => {
  if (typeof window === "undefined") return memory;
  const overlay =
    mergeAttributionMonotonic(pendingWrite, unsavedFallback) || pendingWrite || unsavedFallback;
  if (!cookiesAllowed()) {
    const session = readSessionRaw();
    return mergeAttributionMonotonic(session, overlay) || session || overlay || memory;
  }
  const cookies = readCookiesRaw();
  const session = readSessionRaw();
  const stored = session
    ? mergeAttributionMonotonic(cookies, session) || cookies || session
    : cookies;
  if (session) {
    runQueueThawPromotion(rememberMerged);
  }
  return mergeAttributionMonotonic(stored, overlay) || stored || overlay || memory;
};

export const writeStoredAttribution = (value) => {
  const normalized = normalizeStoredJourney(value) || value;
  rememberMerged(normalized);
  if (typeof window === "undefined") return;
  ensureAttributionSync();
  if (!hasLocks()) {
    runWriteSync(normalized, rememberMerged);
    return;
  }
  pendingWriteSeq += 1;
  const seq = pendingWriteSeq;
  pendingWrite = mergeAttributionMonotonic(normalized, pendingWrite) || normalized;
  withBothLocks(() => runWriteSync(normalized, rememberMerged))
    .catch(() => {})
    .finally(() => {
      if (pendingWriteSeq === seq) {
        pendingWrite = null;
      }
    });
};

export const storeAttributionForConsent = () => {
  if (typeof window === "undefined") return;
  ensureAttributionSync();
  if (!cookiesAllowed()) {
    if (!ALL_COOKIES.some((name) => readCookie(name))) return;
    const clear = () => {
      if (cookiesAllowed()) return;
      const cookies = readCookiesRaw();
      const merged = cookies ? mergeAttributionMonotonic(cookies, readSessionRaw()) : null;
      if (merged) {
        rememberMerged(merged);
        writeSessionRaw(merged);
      }
      removeCookies();
    };
    if (!hasLocks()) {
      clear();
      return;
    }
    withBothLocks(clear).catch(() => {});
    return;
  }
  if (readSessionRaw()) {
    runQueueThawPromotion(rememberMerged);
  }
};

export const runConsentTransition = (target, announce) => {
  ensureAttributionSync();
  const keepDecline = () => {
    const now = String(Date.now());
    for (const storage of STORAGES) {
      try {
        window[storage].setItem(DECLINED_KEY, now);
      } catch {}
    }
  };
  const localFallback = (merged = null) => {
    if (target !== "granted") keepDecline();
    try {
      if (CHOICES.has(target)) {
        window.sessionStorage.setItem(CONSENT_KEY, target);
      } else {
        window.sessionStorage.removeItem(CONSENT_KEY);
      }
    } catch {}
    keepUnsaved(target);
    if (target !== "granted") {
      if (merged) {
        saveSessionOrFallback(merged);
      }
      removeCookies();
    }
    announce(target);
  };
  const clearLocalOverride = (targetChoice = "") => {
    try {
      window.sessionStorage.removeItem(CONSENT_KEY);
    } catch {}
    keepUnsaved(targetChoice);
  };
  const promoteGrantedAttribution = (replies = []) => {
    let merged = mergeAttributionMonotonic(readCookiesRaw(), readSessionRaw());
    merged = mergeAttributionMonotonic(merged, pendingWrite);
    merged = mergeAttributionMonotonic(merged, unsavedFallback);
    merged = mergeAttributionMonotonic(merged, memory);
    for (const rep of replies) {
      if (rep.attribution) {
        merged = mergeAttributionMonotonic(merged, rep.attribution);
      }
    }
    if (!merged) return true;
    rememberMerged(merged);
    const wrote = writeCookiesRaw(merged);
    if (wrote) {
      unsavedFallback = null;
      writeSessionRaw(null);
    } else {
      saveSessionOrFallback(merged);
    }
    return wrote;
  };
  const applyDecline = () => {
    const merged = mergeAttributionMonotonic(readCookiesRaw(), readLocalSession());
    const stage = commitSharedTransition(target);
    if (!stage.ok) {
      localFallback(merged);
      return { ok: false, changed: false, epoch: stage.epoch, merged };
    }
    keepDecline();
    clearLocalOverride(target);
    if (merged) {
      saveSessionOrFallback(merged);
    }
    if (!cookiesAllowed()) {
      removeCookies(["_fbp", "_fbc"]);
    }
    return { ...stage, merged };
  };
  const runUnlocked = () => {
    if (target === "granted") {
      const stage = commitSharedTransition("granted");
      if (!stage.ok) {
        localFallback();
        return;
      }
      clearLocalOverride("granted");
      if (
        cookiesAllowed() &&
        (stage.changed || readSessionRaw() || pendingWrite || unsavedFallback || memory)
      ) {
        promoteGrantedAttribution();
      }
      announce("granted");
      return;
    }
    const stage = applyDecline();
    if (!stage.ok) return;
    if (!cookiesAllowed()) {
      removeCookies();
    }
    announce(target);
  };

  if (!hasLocks()) {
    runUnlocked();
    return;
  }

  let started = false;
  const fallbackIfNotStarted = () => {
    if (started) return undefined;
    started = true;
    runUnlocked();
    return undefined;
  };

  if (target === "granted") {
    return withLock(
      COOKIE_LOCK,
      async () => {
        const stage = await withLock(
          STATE_LOCK,
          () => {
            started = true;
            const next = commitSharedTransition("granted");
            if (!next.ok) {
              localFallback();
              return next;
            }
            clearLocalOverride("granted");
            return next;
          },
          fallbackIfNotStarted,
        );
        if (!stage || !stage.ok) return;
        if (!stage.changed) {
          if (readSessionRaw() || pendingWrite || unsavedFallback || memory) {
            await withLock(STATE_LOCK, () => {
              if (cookiesAllowed()) promoteGrantedAttribution();
            });
          }
          announce("granted");
          return;
        }
        const peers = await discoverPeers();
        const reqId = makeId();
        let replies = [];
        if (peers.size) {
          const wait = waitPeers(peers, "session_attribution_reply", reqId);
          postMsg({ type: "collect_session_attribution", requestId: reqId, peerIds: [...peers] });
          replies = await wait;
        }
        const promotedCookies = await withLock(STATE_LOCK, () => {
          if (!cookiesAllowed()) return false;
          return promoteGrantedAttribution(replies);
        });
        if (promotedCookies) {
          const responded = new Set();
          const byPeer = {};
          for (const rep of replies) {
            if (!rep.tabId) continue;
            const pid = String(rep.tabId);
            responded.add(pid);
            const capturedAt = normalizeStoredJourney(rep.attribution)?.lastTouch?.capturedAt;
            if (typeof capturedAt === "string") {
              byPeer[pid] = capturedAt;
            }
          }
          if (responded.size) {
            const waitAck = waitPeers(responded, "session_attribution_promoted_ack", reqId);
            postMsg({
              type: "session_attribution_promoted",
              consentEpoch: stage.epoch,
              targetConsent: "granted",
              requestId: reqId,
              peerIds: [...responded],
              collectedCapturedAtByPeer: byPeer,
            });
            await waitAck;
          }
        }
        announce("granted");
      },
      fallbackIfNotStarted,
    ).catch(() => {});
  }

  return withLock(
    COOKIE_LOCK,
    async () => {
      const stage = await withLock(
        STATE_LOCK,
        () => {
          started = true;
          return applyDecline();
        },
        fallbackIfNotStarted,
      );
      if (!stage || !stage.ok) return;
      if (stage.changed) {
        const peers = await discoverPeers();
        if (peers.size) {
          const reqId = makeId();
          const wait = waitPeers(peers, "sync_declined_ack", reqId);
          postMsg({
            type: "sync_declined_attribution",
            consentEpoch: stage.epoch,
            targetConsent: target,
            requestId: reqId,
            attribution: stage.merged,
          });
          await wait;
        }
      }
      if (ALL_COOKIES.some((name) => readCookie(name))) {
        await withLock(STATE_LOCK, () => {
          if (!cookiesAllowed()) {
            removeCookies();
          }
        });
      }
      announce(target);
    },
    fallbackIfNotStarted,
  ).catch(() => {});
};
