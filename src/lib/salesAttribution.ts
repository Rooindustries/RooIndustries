import {
  campaignLabel, decodeFrozenPrior, mergeJourneyMonotonic, newJourneyId, resolveFrozenJourney, sanitizeJourney, sanitizeReferrerHost, touchFromSnap,
} from "./campaignSanitizer";
import { normalizeLinkReferral } from "./refShape.js";
import { chooseFirstTouchRef, sanitizeRefEntry } from "./refEntry.js";
import { salesPath } from "./salesPaths";
import { getCurrentArrivalSnapshot } from "./loadPostHog";
import { isRecord, readStoredAttribution, writeStoredAttribution } from "./attributionStore";

const PENDING_KEY = "roo_pending_arrival_touch";
const C_FIELDS = ["source", "medium", "campaign", "content", "term"] as const;
const TOUCH_KEYS = ["creatorCode", ...C_FIELDS, "fbclid", "gclid"] as const;
export { campaignLabel, readStoredAttribution, writeStoredAttribution };

export type RefAttribution = { source: string; capturedAt: string };
export type SalesTouch = {
  capturedAt: string;
  landingPath: string;
  referrerHost?: string;
  creatorCode?: string;
  source?: string;
  medium?: string;
  campaign?: string;
  content?: string;
  term?: string;
  fbclid?: string;
  gclid?: string;
};
type SalesLanding = {
  pathname?: string; search?: string; landingPath?: string; capturedAt?: string;
  referrerHost?: string; campaign?: Record<string, string>; referral?: string; ignoreUrlReferral?: boolean; revisit?: boolean;
};
export type SalesAttribution = {
  version: 2;
  journeyId: string;
  firstTouch: SalesTouch;
  lastTouch: SalesTouch;
  ref?: RefAttribution;
} | { ref: RefAttribution };

type JourneyOnly = Exclude<SalesAttribution, { ref: RefAttribution }>;
type PriorTouches = { journeyId?: string; firstTouch: SalesTouch; lastTouch: SalesTouch };
type ParsedSnap = { touch: SalesTouch; tagged: boolean; revisit?: boolean };

export function sanitizeSalesAttribution(value: unknown, now: number | null = Date.now()): SalesAttribution | null {
  if (!isRecord(value)) return null;
  const ref = sanitizeRefEntry(value.ref, now);
  const journey = sanitizeJourney(value) as JourneyOnly | null;
  if (!journey) return ref ? { ref } : null;
  return ref ? { ...journey, ref } : journey;
}

const readStoredJourney = () =>
  mergeJourneyMonotonic(sanitizeJourney(readStoredAttribution()), sanitizeJourney(typeof window !== "undefined" ? (window as Window & { __rooAttrOverlay?: unknown }).__rooAttrOverlay : null)) as JourneyOnly | null;
const readPending = () => {
  try { return JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null"); } catch { return null; }
};
const wrapTouch = (journeyId: string, touch: SalesTouch): JourneyOnly => ({ version: 2, journeyId, firstTouch: { ...touch }, lastTouch: { ...touch } });
const mergeTouch = (base: JourneyOnly | null, touch: SalesTouch): JourneyOnly | null => {
  const id = base?.journeyId || newJourneyId();
  return id ? ((base ? mergeJourneyMonotonic(base, wrapTouch(id, touch)) : wrapTouch(id, touch)) as JourneyOnly) : null;
};
const clearPendingIfCurrent = (touch: SalesTouch) => {
  try {
    const raw = readPending();
    const p = raw ? (touchFromSnap(raw) as ParsedSnap | null) : null;
    if (raw && (!p || (p.touch.capturedAt === touch.capturedAt && p.touch.landingPath === touch.landingPath && TOUCH_KEYS.every((k) => (p.touch[k] || "") === (touch[k] || ""))))) {
      sessionStorage.removeItem(PENDING_KEY);
    }
  } catch {}
};

export function attributionForLandingSnapshot(landing: unknown): SalesAttribution | null {
  try {
    if (typeof window === "undefined") return null;
    const parsed = touchFromSnap(landing) as ParsedSnap | null;
    if (!parsed) return captureSalesAttribution();
    const [stored, ownId, snapMs] = [readStoredJourney(), newJourneyId(), Date.parse(parsed.touch.capturedAt)];
    if (!stored && !ownId) return null;
    const hasFrozenPrior = isRecord(landing) && Object.hasOwn(landing, "prior");
    let prior = (hasFrozenPrior ? decodeFrozenPrior(landing.prior) : stored) as PriorTouches | null;
    if (!hasFrozenPrior && prior && Number.isFinite(snapMs)) {
      if (Date.parse(prior.firstTouch.capturedAt) > snapMs) prior = null;
      else if (Date.parse(prior.lastTouch.capturedAt) > snapMs) prior = { ...prior, lastTouch: { ...prior.firstTouch } };
    }
    const [earlier, journeyId] = [Boolean(prior && snapMs < Date.parse(prior.firstTouch.capturedAt)), prior?.journeyId || stored?.journeyId || ownId];
    const eventAttr: JourneyOnly = {
      version: 2, journeyId,
      firstTouch: prior && !earlier ? { ...prior.firstTouch } : { ...parsed.touch },
      lastTouch: parsed.tagged && !parsed.revisit ? { ...parsed.touch } : prior?.lastTouch ? { ...prior.lastTouch } : { ...parsed.touch },
    };
    const storedEarlier = Boolean(stored && Date.parse(eventAttr.firstTouch.capturedAt) < Date.parse(stored.firstTouch.capturedAt));
    const next = stored ? ((parsed.tagged && !parsed.revisit) || storedEarlier ? (mergeJourneyMonotonic(stored, eventAttr) as JourneyOnly) : stored) : eventAttr;
    if (next) writeStoredAttribution(next, parsed.tagged ? () => clearPendingIfCurrent(parsed.touch) : undefined);
    return eventAttr;
  } catch { return null; }
}

export function captureSalesAttribution(landing?: SalesLanding): SalesAttribution | null {
  try {
    if (typeof window === "undefined") return null;
    const active = landing ?? (getCurrentArrivalSnapshot() as SalesLanding | null);
    const snap = touchFromSnap(landing || active?.landingPath === salesPath(window.location.pathname) ? active : null) as ParsedSnap | null;
    const [pathname, search] = [snap ? snap.touch.landingPath : landing?.pathname || window.location.pathname, snap ? "" : landing?.search ?? window.location.search];
    if (!snap && !/^\/admin(?:\/|$)/.test(pathname)) {
      try { (window as Window & { __rooCaptureRef?: (s?: string, p?: string) => unknown }).__rooCaptureRef?.(search, pathname); } catch {}
    }
    const landingPath = salesPath(pathname);
    if (!landingPath) return null;
    let [stored, pendingMerged] = [readStoredJourney(), null as SalesTouch | null];
    const pending = touchFromSnap(readPending()) as ParsedSnap | null;
    if (pending?.tagged && !pending.revisit && (!snap || Date.parse(pending.touch.capturedAt) <= Date.parse(snap.touch.capturedAt))) {
      const merged = mergeTouch(stored, pending.touch);
      if (merged) [stored, pendingMerged] = [merged, pending.touch];
    }
    let built = snap;
    if (!built) {
      let [referrerHost, referral] = ["", ""];
      try {
        const r = new URL(document.referrer);
        if (r.origin !== window.location.origin) referrerHost = sanitizeReferrerHost(r.hostname);
      } catch {}
      try { referral = normalizeLinkReferral(sessionStorage.getItem("referral_session")); } catch {}
      built = touchFromSnap({ landingPath, capturedAt: new Date().toISOString(), referrerHost, search, referral }) as ParsedSnap | null;
    }
    const [touch, tagged] = [built?.touch || null, built?.tagged || false];
    const changed = Boolean(touch) && tagged && !built?.revisit && TOUCH_KEYS.some((k) => touch![k] !== stored?.lastTouch[k]);
    const earlier = Boolean(stored && touch && Date.parse(touch.capturedAt) < Date.parse(stored.firstTouch.capturedAt));
    const current = (!stored || changed || earlier) && touch ? mergeTouch(stored, touch) : stored;
    if (!current) return null;
    writeStoredAttribution(current, () => {
      if (pendingMerged) clearPendingIfCurrent(pendingMerged);
      if (touch && (!snap || tagged)) clearPendingIfCurrent(touch);
    });
    return current;
  } catch { return null; }
}

export function salesEventProperties(attribution: unknown = captureSalesAttribution()) {
  const value = sanitizeSalesAttribution(attribution, null);
  if (!value) return {};
  if (!("version" in value)) {
    return value.ref?.source ? { ref_source: value.ref.source } : {};
  }
  const { firstTouch: f, lastTouch: l } = value;
  const p: Record<string, string | boolean> = {
    journey_id: value.journeyId,
    landing_path: l.landingPath,
    has_fbclid: Boolean(l.fbclid || f.fbclid),
    has_gclid: Boolean(l.gclid || f.gclid),
  };
  for (const k of C_FIELDS) if (l[k]) p[k === "campaign" ? k : `campaign_${k}`] = l[k]!;
  if (l.creatorCode) p.creator_code = l.creatorCode;
  if (l.referrerHost) p.referrer_host = l.referrerHost;
  if (f.source) p.first_source = f.source;
  if (f.campaign) p.first_campaign = f.campaign;
  if (value.ref?.source) p.ref_source = value.ref.source;
  return p;
}

export const journeySalesAttribution = () =>
  captureSalesAttribution() || sanitizeSalesAttribution(readStoredAttribution());

export const captureVisit = (landing: SalesLanding, prior: unknown) => {
  const saved = captureSalesAttribution(landing);
  return attributionForLandingSnapshot({ ...landing, prior }) || saved;
};

export function resolveBookingAttribution(stored?: unknown, arrivalSnapshot?: unknown, frozenRaw?: unknown): SalesAttribution | null {
  let ref = null;
  try {
    const liveRef = isRecord(frozenRaw) && Object.hasOwn(frozenRaw, "r") ? frozenRaw.r : typeof window !== "undefined" ? (window as Window & { __rooReadRef?: () => unknown }).__rooReadRef?.() ?? null : null;
    ref = chooseFirstTouchRef([liveRef, isRecord(stored) ? stored.ref : null]);
  } catch {}
  try {
    let [base, hadBase] = resolveFrozenJourney(stored, arrivalSnapshot, isRecord(frozenRaw) ? frozenRaw : null, readStoredJourney(), readPending()) as [JourneyOnly | null, boolean];
    if (!hadBase && base) {
      const id = readStoredJourney()?.journeyId;
      if (id) base = { ...base, journeyId: id };
      writeStoredAttribution(base);
    }
    if (!base && !arrivalSnapshot) base = sanitizeJourney(captureSalesAttribution()) as JourneyOnly | null;
    return !base ? (ref ? { ref } : null) : ref ? { ...base, ref } : base;
  } catch { return ref ? { ref } : null; }
}
