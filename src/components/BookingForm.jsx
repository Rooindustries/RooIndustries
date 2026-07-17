import React, { useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { getPublicContent } from "../lib/publicContentClient";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import useHomeSectionLinkHandler from "../lib/useHomeSectionLinkHandler";
import packageContent from "../lib/packageContent";
import packagePricing from "../lib/packagePricing";
import PriceDisplay from "./PriceDisplay";
import { getWarrantyCallout } from "./Packages";
import {
  BOOKING_DRAFT_STORAGE_KEY,
  CHECKOUT_BOOKING_STORAGE_KEY,
  persistBookingPackageSelection,
  readStoredCheckoutBooking,
  updateStoredCheckoutHold,
} from "../lib/checkoutStorage";
import {
  calculateCheckoutDiscounts,
  resolveCheckoutCode,
  sanitizeCouponForCheckout,
  sanitizeReferralForCheckout,
  toMoney,
} from "../lib/checkoutCodes";

const { applyPackageContentOverrides } = packageContent;
const {
  applyPackagePricing,
  getPackageTitleAliases,
  isTopPackageTitle,
} = packagePricing;
const preparePackage = (pkg) =>
  applyPackageContentOverrides(applyPackagePricing(pkg));
const DEFAULT_VERTEX_PACKAGE = preparePackage({
  title: "Performance Vertex Overhaul",
  price: "$79.95",
});

const IST_OFFSET_MINUTES = 330;
const FORM_PREFILL_KEY = "booking_form_prefill";
const HOLD_STORAGE_KEY = "my_slot_hold";
const BOOKING_DRAFT_KEY = BOOKING_DRAFT_STORAGE_KEY;
const PAYMENT_SESSION_STORAGE_KEY = "payment_session_state";
const BOOKING_CONFIRMATION_STORAGE_KEY = "booking_confirmation_state";
const SESSION_STATE_KEY = "booking_modal_state";
const REFERRAL_STORAGE_KEY = "referral_session";
const INVALID_CHECKOUT_CODE_MESSAGE = "Invalid referral or coupon code.";
const BOOKING_FETCH_TIMEOUT_MS = 8000;
const REASSURANCE_COPY =
  "You won't be charged until you confirm on the payment page.";
const PAYMENT_PENDING_EXPIRY_ERROR =
  "This reservation expired while payment is still pending. Return to payment to check its status or release payment to try again.";
const BOOKING_STEPS = ["Pick a slot", "PC details", "Review & pay"];
const STEP_PROGRESS_LABELS = {
  1: "Step 1 of 3",
  2: "Step 2 of 3",
  3: "Step 3 of 3",
};
const STEP_PROGRESS_WIDTHS = { 1: "33%", 2: "67%", 3: "100%" };
const STEP_PROGRESS_PERCENTS = { 1: 33, 2: 67, 3: 100 };
const createFreshForm = () => ({
  discord: "",
  email: "",
  specs: "",
  mainGame: "",
  notes: "",
});
const normalizeForm = (value = {}) => ({
  discord: typeof value.discord === "string" ? value.discord : "",
  email: typeof value.email === "string" ? value.email : "",
  specs: typeof value.specs === "string" ? value.specs : "",
  mainGame: typeof value.mainGame === "string" ? value.mainGame : "",
  notes: typeof value.notes === "string" ? value.notes : "",
});
const readReferralFromSession = () => {
  try {
    return sessionStorage.getItem(REFERRAL_STORAGE_KEY) || "";
  } catch {
    return "";
  }
};
const formatUsd = (value) => `$${toMoney(value).toFixed(2)}`;
const getDraftKey = (pkg) => (pkg?.title ? pkg.title : "_default");
const isDraftEmpty = (formObj) =>
  !String(formObj?.discord || "").trim() &&
  !String(formObj?.email || "").trim() &&
  !String(formObj?.specs || "").trim() &&
  !String(formObj?.mainGame || "").trim() &&
  !String(formObj?.notes || "").trim();

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const UPGRADE_FAQ_HASH = "upgrade-path";

const getUtcFromHostLocal = (year, monthIndex, day, hostHour) => {
  const utcMs =
    Date.UTC(year, monthIndex, day, hostHour, 0) -
    IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs);
};

// Format a UTC Date into the user's local time string
const formatLocalTime = (utcDate, timeZone) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(timeZone ? { timeZone } : {}),
      hour: "numeric",
      minute: "2-digit",
    }).format(utcDate);
  } catch {
    return utcDate.toISOString();
  }
};

const formatLocalDate = (utcDate, timeZone) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(timeZone ? { timeZone } : {}),
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(utcDate);
  } catch {
    return utcDate.toISOString();
  }
};

const getLocalDateKey = (utcDate, timeZone) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      ...(timeZone ? { timeZone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(utcDate)
      .reduce((acc, cur) => {
        acc[cur.type] = cur.value;
        return acc;
      }, {});

    const year = Number(parts.year);
    const month = Number(parts.month);
    const day = Number(parts.day);
    if (!year || !month || !day) return "";
    return new Date(year, month - 1, day).toDateString();
  } catch {
    const fallback = new Date(utcDate);
    if (Number.isNaN(fallback.getTime())) return "";
    fallback.setHours(0, 0, 0, 0);
    return fallback.toDateString();
  }
};

const formatCountdown = (ms) => {
  if (!ms || ms <= 0) return "0:00";
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const formatShortLocalDate = (utcDate, timeZone) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      ...(timeZone ? { timeZone } : {}),
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(utcDate);
  } catch {
    return utcDate.toLocaleDateString();
  }
};

function BookingStepTracker({ step }) {
  return (
    <div className="mb-6" data-testid="booking-step-tracker">
      <ol
        aria-label="Booking progress"
        className="grid grid-cols-3 gap-2 text-center"
      >
        {BOOKING_STEPS.map((label, index) => {
          const stepNumber = index + 1;
          const isActive = step === stepNumber;
          const isComplete = step > stepNumber;
          return (
            <li
              key={label}
              aria-current={isActive ? "step" : undefined}
              className={`rounded-lg border px-2 py-2 text-xs sm:px-3 sm:py-2.5 sm:text-sm font-semibold transition ${
                isActive
                  ? "border-info-border bg-info-soft text-info-text"
                  : isComplete
                  ? "border-line-input text-accent"
                  : "border-line-input text-ink-muted"
              }`}
            >
              <span aria-hidden="true" className="mr-1">
                {isComplete ? "✓" : `${stepNumber})`}
              </span>
              {label}
            </li>
          );
        })}
      </ol>
      <div
        className="relative mt-2 pb-5"
        role="progressbar"
        aria-valuenow={STEP_PROGRESS_PERCENTS[step]}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={STEP_PROGRESS_LABELS[step]}
        aria-label="Booking progress"
      >
        <div className="h-0.5 w-full rounded-full bg-surface-input">
          <div
            className="h-0.5 rounded-full bg-accent-strong transition-all duration-300"
            style={{ width: STEP_PROGRESS_WIDTHS[step] }}
          />
        </div>
        <span
          aria-hidden="true"
          className="absolute top-2 text-[11px] font-medium text-accent transition-all duration-300"
          style={{
            left: STEP_PROGRESS_WIDTHS[step],
            transform: step === 3 ? "translateX(-100%)" : "translateX(-50%)",
          }}
        >
          {STEP_PROGRESS_WIDTHS[step]}
        </span>
      </div>
    </div>
  );
}

function HoldBanner({
  active,
  countdownMs,
  isPaymentPending,
  localTimeLabel,
  onRelease,
  className = "",
}) {
  if (!active) return null;

  return (
    <div
      className={`rounded-xl border border-purple-500/40 bg-purple-500/10 px-4 py-3 ${className}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs font-medium text-ink sm:text-sm">
          Slot <strong>{localTimeLabel || "--"}</strong> is reserved.{" "}
          <span className="text-info-text">
            Expires in {formatCountdown(countdownMs)}.
          </span>
        </p>
        {!isPaymentPending && (
          <button
            type="button"
            onClick={onRelease}
            className="inline-flex items-center justify-center rounded-lg border border-purple-300/40 bg-purple-900/40 px-3 py-1.5 text-xs font-semibold text-purple-100 transition hover:bg-purple-800/60"
          >
            Release Slot
          </button>
        )}
      </div>
    </div>
  );
}

const fetchJsonWithRetry = async (
  url,
  options = {},
  attempts = 3,
  delayMs = 250,
  timeoutMs = BOOKING_FETCH_TIMEOUT_MS
) => {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const controller =
      typeof AbortController === "function" ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => {
          controller.abort();
        }, timeoutMs)
      : null;

    try {
      const response = await fetch(url, {
        ...options,
        cache: "no-store",
        signal: controller?.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok === false) {
        throw new Error(
          data?.error || data?.message || "Request failed."
        );
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      await new Promise((res) => setTimeout(res, delayMs));
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }
  throw lastErr || new Error("Unable to fetch booking data.");
};

const broadcastHold = (payload) => {
  try {
    window.dispatchEvent(new CustomEvent("hold-state", { detail: payload }));
  } catch {
    console.error("Failed to broadcast hold state");
  }
};

const parseDateKey = (value) => {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toDateString();
  }
  if (typeof value !== "string") return null;
  const datePart = value.split("T")[0];
  const [year, month, day] = datePart.split("-").map((num) => Number(num));
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return null;
  return date.toDateString();
};

const parseHourValue = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value).trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})(?::\d{2})?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  return hour;
};

const normalizeDateSlots = (slots) => {
  const map = {};
  (slots || []).forEach((slot) => {
    const dateKey = parseDateKey(slot?.date);
    if (!dateKey) return;
    const timesRaw = Array.isArray(slot?.times) ? slot.times : [];
    const hours = timesRaw
      .map((time) => parseHourValue(time))
      .filter((time) => Number.isFinite(time));
    const unique = Array.from(new Set(hours)).sort((a, b) => a - b);
    if (!unique.length) return;
    map[dateKey] = unique;
  });
  return map;
};

const normalizePackageKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const normalizePackageDateSlots = (entries) => {
  const map = {};
  (entries || []).forEach((entry) => {
    const titleKeys = getPackageTitleAliases(entry?.package?.title).map(
      normalizePackageKey
    );
    if (!titleKeys.length) return;
    const slots = normalizeDateSlots(entry?.dateSlots);
    if (!Object.keys(slots).length) return;
    titleKeys.forEach((titleKey) => {
      map[titleKey] = slots;
    });
  });
  return map;
};

const getUtcDateFromHold = (hold) => {
  if (!hold?.startTimeUTC) return null;
  const fromStart = new Date(hold.startTimeUTC);
  return Number.isNaN(fromStart.getTime()) ? null : fromStart;
};

// Accepts isMobile prop from BookingModal to force layout styles
export default function BookingForm({ isMobile }) {
  const handleHomeSectionLink = useHomeSectionLinkHandler();
  const location = useLocation();
  const navigate = useNavigate();
  const referralQuery = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return {
      code: String(params.get("ref") || "").trim(),
      present: params.has("ref"),
    };
  }, [location.search]);

  const [step, setStep] = useState(1);
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState("");
  const [settingsReloadKey, setSettingsReloadKey] = useState(0);

  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);

  const [month, setMonth] = useState(new Date());
  const [loading, setLoading] = useState(false);
  const [errorStep1, setErrorStep1] = useState("");
  const [errorStep2, setErrorStep2] = useState("");

  const [userTimeZone, setUserTimeZone] = useState("UTC");

  useEffect(() => {
    try {
      setUserTimeZone(
        Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
      );
    } catch {
      setUserTimeZone("UTC");
    }
  }, []);

  const [form, setForm] = useState(createFreshForm);
  const [codeEntryOpen, setCodeEntryOpen] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [codeError, setCodeError] = useState("");
  const [validatingCode, setValidatingCode] = useState(false);
  const [appliedReferral, setAppliedReferral] = useState(null);
  const [appliedCoupon, setAppliedCoupon] = useState(null);
  const [dismissedReferralCode, setDismissedReferralCode] = useState("");
  const [restoredCodeCandidates, setRestoredCodeCandidates] = useState(null);
  const autoReferralAttemptRef = useRef("");
  const hasActiveHoldRef = useRef(false);

  const [showVertexModal, setShowVertexModal] = useState(false);
  const [vertexPackage, setVertexPackage] = useState(null);
  const [vertexEssentialsPackage, setVertexEssentialsPackage] = useState(null);
  const [planPackage, setPlanPackage] = useState(null);
  const [modalPackage, setModalPackage] = useState(null);
  const [modalMode, setModalMode] = useState("switch");
  const [pageFadeIn, setPageFadeIn] = useState(false);
  const scrollLockRef = useRef(null);
  const [persistedPackage, setPersistedPackage] = useState(null);
  const [preventHoldAutoload, setPreventHoldAutoload] = useState(false);
  const [drafts, setDrafts] = useState({});

  const navigationPackage = useMemo(() => {
    const direct = location.state?.bookingPackage;
    if (direct?.title) return direct;
    const bookingData = location.state?.bookingData;
    if (!bookingData?.packageTitle) return null;
    return {
      title: bookingData.packageTitle,
      price: bookingData.packagePrice || "",
      tag: bookingData.packageTag || "",
    };
  }, [location.state]);

  // Package selection comes from navigation state or tab-scoped storage.
  const selectedPackage = useMemo(() => {
    if (navigationPackage?.title) return preparePackage(navigationPackage);
    if (persistedPackage) return preparePackage(persistedPackage);
    return DEFAULT_VERTEX_PACKAGE;
  }, [navigationPackage, persistedPackage]);

  const prevPackageRef = useRef(selectedPackage.title);
  const prevPackageDataRef = useRef(selectedPackage);
  const [draftLoading, setDraftLoading] = useState(true);
  const [myHold, setMyHold] = useState(null);
  const isPaymentPendingHold =
    String(myHold?.phase || "").trim().toLowerCase() === "payment_pending";
  const [lockingSlot, setLockingSlot] = useState(false);
  const [holdCountdownMs, setHoldCountdownMs] = useState(null);
  const [releasingPayment, setReleasingPayment] = useState(false);
  const [paymentReleaseStatus, setPaymentReleaseStatus] = useState("");
  const clearedNoHoldRef = useRef(false);
  const [restoredSessionPackageTitle, setRestoredSessionPackageTitle] =
    useState("");

  const closeVertexModal = () => {
    document.body.classList.remove("is-modal-blur");
    setShowVertexModal(false);
  };

  const renderFeatureWithUpgradeLink = (text = "") => {
    if (!/future upgrade path/i.test(text)) return text;

    return text.split(/(Future Upgrade Path)/i).map((part, idx) => {
      const isMatch = /future upgrade path/i.test(part);
      if (isMatch) {
        return (
          <Link
            key={`upgrade-link-${idx}`}
            to={`/#${UPGRADE_FAQ_HASH}`}
            className="underline underline-offset-2 transition"
            style={{ color: "var(--color-accent)" }}
            onClick={(event) => {
              handleHomeSectionLink(event, `#${UPGRADE_FAQ_HASH}`);
              closeVertexModal();
            }}
          >
            {part}
          </Link>
        );
      }

      return <React.Fragment key={`upgrade-text-${idx}`}>{part}</React.Fragment>;
    });
  };

  // Persist referral from URL into session storage; clear only if explicitly blank
  useEffect(() => {
    try {
      const normalizedDismissed = dismissedReferralCode.toLowerCase();
      if (
        referralQuery.code &&
        referralQuery.code.toLowerCase() !== normalizedDismissed
      ) {
        sessionStorage.setItem(REFERRAL_STORAGE_KEY, referralQuery.code);
      } else if (referralQuery.present || normalizedDismissed) {
        sessionStorage.removeItem(REFERRAL_STORAGE_KEY);
      }
    } catch {
      console.error("Failed to persist referral session");
    }
  }, [dismissedReferralCode, referralQuery]);

  useEffect(() => {
    const prevTitle = prevPackageRef.current;
    const nextTitle = selectedPackage.title;
    if (prevTitle && prevTitle !== nextTitle) {
      const prevPkgData = prevPackageDataRef.current;
      if (
        prevPkgData &&
        !isDraftEmpty(form)
      ) {
        persistDraft({
          form: { ...form },
          selectedPackage: { ...prevPkgData },
        });
      }
      setPreventHoldAutoload(true);
      setErrorStep1("");
      setErrorStep2("");
      setSelectedSlot(null);
      setStep(1);
    }
    prevPackageRef.current = nextTitle;
    prevPackageDataRef.current = selectedPackage;
  }, [selectedPackage.title]);

  // Restore modal session state if present
  useEffect(() => {
    if (!selectedPackage.title) return;
    try {
      const raw = sessionStorage.getItem(SESSION_STATE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.packageTitle === selectedPackage.title) {
          const savedStep = Number(saved.step);
          const restoredStep = Number.isFinite(savedStep)
            ? Math.min(3, Math.max(1, Math.trunc(savedStep)))
            : 1;
          setStep(restoredStep);
          if (saved.month) {
            const m = new Date(saved.month);
            if (!isNaN(m)) setMonth(m);
          }
          let restoredDate = false;
          if (saved.selectedSlot?.utcStart) {
            const utcStart = new Date(saved.selectedSlot.utcStart);
            if (!isNaN(utcStart.getTime())) {
              const slotId = saved.selectedSlot.slotId || utcStart.toISOString();
              setSelectedSlot({
                slotId,
                utcStart,
                localLabel: saved.selectedSlot.localLabel || "",
              });
              const localDate = new Date(utcStart);
              localDate.setHours(0, 0, 0, 0);
              setSelectedDate(localDate);
              restoredDate = true;
            }
          }
          if (!restoredDate && saved.selectedDate) {
            const d = new Date(saved.selectedDate);
            if (!isNaN(d)) setSelectedDate(d);
          }
        }
      }
    } catch {
      console.error("Failed to restore session state");
    } finally {
      setRestoredSessionPackageTitle(selectedPackage.title);
    }
  }, [selectedPackage.title]);

  // Persist modal session state
  useEffect(() => {
    if (restoredSessionPackageTitle !== selectedPackage.title) return;
    try {
      const payload = {
        packageTitle: selectedPackage.title,
        step,
        month: month?.toISOString?.() || null,
        selectedDate: selectedDate?.toISOString?.() || null,
        selectedSlot: selectedSlot
          ? {
              slotId: selectedSlot.slotId,
              utcStart: selectedSlot.utcStart?.toISOString?.() || null,
              localLabel: selectedSlot.localLabel,
            }
          : null,
      };
      sessionStorage.setItem(SESSION_STATE_KEY, JSON.stringify(payload));
    } catch {
      console.error("Failed to persist session state");
    }
  }, [
    step,
    month,
    selectedDate,
    selectedSlot,
    selectedPackage.title,
    restoredSessionPackageTitle,
  ]);

  // If no active reservation, reset and clear persisted data so we land on times
  useEffect(() => {
    if (draftLoading) return;
    if (myHold) {
      clearedNoHoldRef.current = false;
      return;
    }
    if (clearedNoHoldRef.current) return;

    const key = getDraftKey(selectedPackage);
    clearDraftForPackage(key);
    setForm(createFreshForm());
    setSelectedSlot(null);
    setStep(1);
    clearedNoHoldRef.current = true;
    try {
      sessionStorage.removeItem(SESSION_STATE_KEY);
    } catch {
      console.error("Failed to clear session state");
    }
  }, [draftLoading, myHold, selectedPackage]);

  // Load the tab-scoped hold on mount.
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(HOLD_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // check if expired
        if (new Date(parsed.expiresAt) > new Date()) {
          const normalizedHold = {
            holdId: parsed.holdId,
            holdToken: parsed.holdToken,
            expiresAt: parsed.expiresAt,
            startTimeUTC: parsed.startTimeUTC,
            packageTitle: parsed.packageTitle,
            packagePrice: parsed.packagePrice,
            packageTag: parsed.packageTag,
            phase: parsed.phase || "",
          };
          const utcDate = getUtcDateFromHold(normalizedHold);
          if (!utcDate) {
            sessionStorage.removeItem(HOLD_STORAGE_KEY);
            return;
          }
          normalizedHold.startTimeUTC = utcDate.toISOString();
          sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(normalizedHold));
          setMyHold(normalizedHold);
          broadcastHold(normalizedHold);
        } else {
          sessionStorage.removeItem(HOLD_STORAGE_KEY);
        }
      }
    } catch {
      console.error("Failed to restore slot reservation");
    }
  }, []);

  // Align UI with any active hold (including persisted)
  useEffect(() => {
    if (!myHold) return;
    if (restoredSessionPackageTitle !== selectedPackage.title) return;

    if (preventHoldAutoload) {
      setSelectedSlot(null);
      setStep(1);
      return;
    }

    const samePackage =
      !myHold.packageTitle ||
      !selectedPackage.title ||
      myHold.packageTitle === selectedPackage.title;

    const utcDate = getUtcDateFromHold(myHold);

    if (utcDate && !isNaN(utcDate.getTime())) {
      const localDateKey = getLocalDateKey(utcDate, userTimeZone);
      const localDate = localDateKey ? new Date(localDateKey) : null;
      if (localDate && !Number.isNaN(localDate.getTime())) {
        localDate.setHours(0, 0, 0, 0);
        setSelectedDate(localDate);
      }
    }

    if (samePackage && utcDate) {
      const slotId = utcDate.toISOString();
      const localLabel = formatLocalTime(utcDate, userTimeZone);
      setSelectedSlot((prev) => {
        if (prev?.slotId === slotId && prev.localLabel === localLabel) {
          return prev;
        }
        return { slotId, utcStart: utcDate, localLabel };
      });
      const paymentPending =
        String(myHold.phase || "").trim().toLowerCase() === "payment_pending";
      setStep((currentStep) =>
        paymentPending ? 3 : currentStep === 3 ? 3 : 2
      );
    } else {
      setSelectedSlot(null);
      setStep(1);
    }
  }, [
    myHold,
    selectedPackage.title,
    preventHoldAutoload,
    restoredSessionPackageTitle,
    userTimeZone,
  ]);

  // Countdown + expiry handling for holds
  useEffect(() => {
    if (!myHold?.expiresAt) {
      setHoldCountdownMs(null);
      return;
    }

    const expiresAtMs = new Date(myHold.expiresAt).getTime();
    if (!Number.isFinite(expiresAtMs)) {
      setHoldCountdownMs(null);
      return;
    }

    const tick = () => {
      const diff = expiresAtMs - Date.now();
      if (diff <= 0) {
        hasActiveHoldRef.current = false;
        setHoldCountdownMs(0);
        const paymentPending =
          String(myHold.phase || "").trim().toLowerCase() === "payment_pending";
        if (paymentPending) {
          setErrorStep2(PAYMENT_PENDING_EXPIRY_ERROR);
        } else {
          releaseHold();
        }
        return false;
      }
      setHoldCountdownMs(diff);
      return true;
    };

    tick();
    const id = setInterval(() => {
      const ok = tick();
      if (!ok) {
        clearInterval(id);
      }
    }, 1000);

    return () => clearInterval(id);
  }, [myHold]);

  const clearErrorIfResolved = (nextForm = form) => {
    if (!errorStep2) return;

    const baseFilled =
      nextForm.discord.trim() &&
      nextForm.email.trim() &&
      nextForm.specs.trim() &&
      nextForm.mainGame.trim();

    if (baseFilled) {
      setErrorStep2("");
    }
  };

  const normalizedPackageTitle = normalizePackageKey(selectedPackage.title);

  const isXoc = isTopPackageTitle(
    selectedPackage.title || selectedPackage.sourceTitle
  );

  const isVertexEssentials =
    normalizedPackageTitle.includes("vertex essential");

  const displayPackage = modalPackage || vertexPackage;
  const isStep2Complete = useMemo(() => {
    return Boolean(
      form.discord.trim() &&
      form.email.trim() &&
      form.specs.trim() &&
        form.mainGame.trim()
    );
  }, [
    form.discord,
    form.email,
    form.specs,
    form.mainGame,
  ]);

  const getStep2Error = () => {
    if (
      !form.discord.trim() ||
      !form.email.trim() ||
      !form.specs.trim() ||
      !form.mainGame.trim()
    ) {
      return "Please fill out all required fields.";
    }

    return "";
  };

  const startOfToday = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);

  const dateSlotMap = useMemo(() => {
    if (!settings) return null;
    const baseMap = settings.dateSlotMap;
    const xocMap = settings.xocDateSlotMap;
    const essentialsMap = settings.vertexEssentialsDateSlotMap;
    const packageMaps = settings.packageDateSlotMaps;
    const packageMap = getPackageTitleAliases(selectedPackage.title)
      .map(normalizePackageKey)
      .map((packageTitleKey) =>
        packageTitleKey && packageMaps ? packageMaps[packageTitleKey] : null
      )
      .find(Boolean);
    const hasBase = baseMap && Object.keys(baseMap).length > 0;
    const hasXoc = xocMap && Object.keys(xocMap).length > 0;
    const hasEssentials =
      essentialsMap && Object.keys(essentialsMap).length > 0;
    const hasPackageMap = packageMap && Object.keys(packageMap).length > 0;

    if (hasPackageMap) return packageMap;
    if (isXoc && hasXoc) return xocMap;
    if (isVertexEssentials && hasEssentials) return essentialsMap;
    if (!isXoc && hasBase) return baseMap;

    if (hasBase) return baseMap;
    if (hasEssentials) return essentialsMap;
    if (hasXoc) return xocMap;
    return null;
  }, [settings, isXoc, isVertexEssentials, selectedPackage.title]);

  const localSlotMap = useMemo(() => {
    if (!dateSlotMap) return null;
    const map = {};
    Object.entries(dateSlotMap).forEach(([hostDateKey, hours]) => {
      const hostDate = new Date(hostDateKey);
      if (Number.isNaN(hostDate.getTime())) return;

      (hours || []).forEach((h) => {
        if (!Number.isFinite(h)) return;
        const utcStart = getUtcFromHostLocal(
          hostDate.getFullYear(),
          hostDate.getMonth(),
          hostDate.getDate(),
          h
        );
        if (Number.isNaN(utcStart.getTime())) return;

        const localDateKey = getLocalDateKey(utcStart, userTimeZone);
        if (!localDateKey) return;

        const slotId = utcStart.toISOString();
        const localLabel = formatLocalTime(utcStart, userTimeZone);

        const list = map[localDateKey] || [];
        list.push({ slotId, utcStart, localLabel });
        map[localDateKey] = list;
      });
    });

    Object.values(map).forEach((list) =>
      list.sort((a, b) => a.utcStart - b.utcStart)
    );

    return map;
  }, [dateSlotMap, userTimeZone]);

  const earliestAvailableSlot = useMemo(() => {
    if (!settings || !localSlotMap) return null;

    const bookedSet = new Set();
    const heldMap = new Map();
    (settings.bookedSlots || []).forEach((slot) => {
      if (!slot.startTimeUTC) return;
      if (slot.isHold) {
        if (slot.isExpiredHold) return;
        heldMap.set(slot.startTimeUTC, slot.holdId || "");
        return;
      }
      bookedSet.add(slot.startTimeUTC);
    });

    const now = new Date();
    const available = Object.values(localSlotMap)
      .flat()
      .filter((slot) => {
        const holdId = heldMap.get(slot.slotId);
        const isHeldOther = !!holdId && holdId !== myHold?.holdId;
        return (
          slot.utcStart > now &&
          !bookedSet.has(slot.slotId) &&
          !isHeldOther
        );
      })
      .sort((left, right) => left.utcStart - right.utcStart);

    const earliest = available[0];
    if (!earliest) return null;
    const localDateKey = getLocalDateKey(earliest.utcStart, userTimeZone);
    const localDate = localDateKey ? new Date(localDateKey) : null;
    if (!localDate || Number.isNaN(localDate.getTime())) return null;
    localDate.setHours(0, 0, 0, 0);
    return { ...earliest, localDate };
  }, [localSlotMap, myHold?.holdId, settings, userTimeZone]);

  const isDateAllowed = (dateObj) => {
    if (!settings) return false;
    const d = new Date(dateObj);
    d.setHours(0, 0, 0, 0);

    if (d < startOfToday) return false;

    if (!localSlotMap) return false;

    const dateKey = d.toDateString();
    const slots = localSlotMap[dateKey];
    return Array.isArray(slots) && slots.length > 0;
  };

  // ---------- FETCH SETTINGS + ACTIVE HOLDS ----------
  useEffect(() => {
    let isActive = true;

    const fetchData = async () => {
      setSettingsError("");
      try {
        const data = await fetchJsonWithRetry("/api/bookingAvailability");
        if (!data?.settings) {
          throw new Error("Missing booking availability settings.");
        }

        const s = { ...data.settings };

        s.dateSlotMap = normalizeDateSlots(s.dateSlots);
        s.xocDateSlotMap = normalizeDateSlots(s.xocDateSlots);
        s.vertexEssentialsDateSlotMap = normalizeDateSlots(
          s.vertexEssentialsDateSlots
        );
        s.packageDateSlotMaps = normalizePackageDateSlots(s.packageDateSlots);
        s.bookedSlots = Array.isArray(data.bookedSlots)
          ? data.bookedSlots
          : [];

        if (isActive) setSettings(s);
      } catch {
        console.error("Failed to fetch booking availability");
        if (isActive) {
          setSettingsError("Booking availability took too long to load.");
        }
      }
    };

    fetchData();
    return () => {
      isActive = false;
    };
  }, [settingsReloadKey]);

  // page fade-in on route change
  useEffect(() => {
    setPageFadeIn(false);
    const t = setTimeout(() => setPageFadeIn(true), 50);
    return () => clearTimeout(t);
  }, [location.key]);

  // Prefill form if coming from XOC switch
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    if (params.get("prefillFromXoc") === "1") {
      try {
        const stored = sessionStorage.getItem(FORM_PREFILL_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          setForm((prev) => normalizeForm({ ...prev, ...parsed }));
          sessionStorage.removeItem(FORM_PREFILL_KEY);
        }
      } catch {
        console.error("Failed to prefill booking form");
      }
    }
  }, [location.search]);

  // Load persisted booking draft (keeps form + package when returning)
  // Load drafts (per-package)
  useEffect(() => {
    try {
      setAppliedReferral(null);
      setAppliedCoupon(null);
      setDismissedReferralCode("");
      setCodeEntryOpen(false);
      setCodeInput("");
      setCodeError("");
      setRestoredCodeCandidates(null);
      const storedDraft = sessionStorage.getItem(BOOKING_DRAFT_KEY);
      if (storedDraft) {
        const parsed = JSON.parse(storedDraft);
        setDrafts(parsed.packages || {});
        const key = getDraftKey(selectedPackage);
        const draftForPkg =
          (parsed.packages && parsed.packages[key]) ||
          (parsed.lastTitle && parsed.packages && parsed.packages[parsed.lastTitle]) ||
          null;
        if (draftForPkg) {
          if (draftForPkg.form) setForm(normalizeForm(draftForPkg.form));
          if (draftForPkg.selectedPackage) {
            setPersistedPackage(draftForPkg.selectedPackage);
          }
          const checkoutCodes = draftForPkg.checkoutCodes;
          if (checkoutCodes && typeof checkoutCodes === "object") {
            const referralCode = String(
              checkoutCodes.referral?.code || ""
            ).trim();
            const couponCode = String(
              checkoutCodes.coupon?.code || ""
            ).trim();
            const dismissedCode = String(
              checkoutCodes.dismissedReferralCode || ""
            ).trim();
            setDismissedReferralCode(dismissedCode);
            if (referralCode || couponCode) {
              setRestoredCodeCandidates({
                referralCode,
                couponCode,
                dismissedCode,
              });
            }
          }
          setPreventHoldAutoload(false);
        }
      }
      setDraftLoading(false);
    } catch {
      console.error("Failed to load booking draft");
      setDraftLoading(false);
    }
  }, [selectedPackage.title]);

  const persistDraft = (payload) => {
    try {
      const current = sessionStorage.getItem(BOOKING_DRAFT_KEY);
      let parsed = { packages: {}, lastTitle: null };
      if (current) {
        parsed = { lastTitle: null, packages: {}, ...JSON.parse(current) };
      }
      const key = getDraftKey(payload.selectedPackage);
      parsed.packages[key] = {
        ...(parsed.packages[key] || {}),
        ...payload,
      };
      parsed.lastTitle = key;
      setDrafts(parsed.packages);
      sessionStorage.setItem(BOOKING_DRAFT_KEY, JSON.stringify(parsed));
    } catch {
      console.error("Failed to persist booking draft");
    }
  };

  const persistCheckoutCodes = ({ referral, coupon, dismissedCode = "" }) => {
    const safeReferral = sanitizeReferralForCheckout(referral);
    const safeCoupon = sanitizeCouponForCheckout(coupon);
    persistDraft({
      form: { ...form },
      selectedPackage: { ...selectedPackage },
      checkoutCodes: {
        referral: safeReferral,
        coupon: safeCoupon,
        dismissedReferralCode: String(dismissedCode || "").trim(),
      },
    });
  };

  const clearDraftForPackage = (pkgKey) => {
    try {
      const current = sessionStorage.getItem(BOOKING_DRAFT_KEY);
      if (!current) return;
      const parsed = { lastTitle: null, packages: {}, ...JSON.parse(current) };
      if (parsed.packages && parsed.packages[pkgKey]) {
        const selectedPackage = parsed.packages[pkgKey]?.selectedPackage;
        if (selectedPackage?.title) {
          parsed.packages[pkgKey] = { selectedPackage };
          parsed.lastTitle = pkgKey;
        } else {
          delete parsed.packages[pkgKey];
          if (parsed.lastTitle === pkgKey) parsed.lastTitle = null;
        }
        setDrafts(parsed.packages);
        sessionStorage.setItem(BOOKING_DRAFT_KEY, JSON.stringify(parsed));
      }
    } catch {
      console.error("Failed to clear booking draft");
    }
  };

  // Lock body scroll when modal is open
  useEffect(() => {
    if (showVertexModal) {
      const body = document.body;
      const html = document.documentElement;
      const scrollY = window.scrollY;
      const original = {
        overflow: body.style.overflow,
        htmlOverflow: html.style.overflow,
        scrollY,
      };
      scrollLockRef.current = original;
      body.classList.add("is-modal-open");
      body.classList.add("is-modal-blur");
      body.style.overflow = "hidden";
      html.style.overflow = "hidden";
      return () => {
        const stored = scrollLockRef.current || original;
        body.classList.remove("is-modal-open");
        body.classList.remove("is-modal-blur");
        body.style.overflow = stored.overflow || "";
        html.style.overflow = stored.htmlOverflow || "";
        window.scrollTo(0, stored.scrollY || 0);
      };
    }
  }, [showVertexModal]);

  // Hide booking modal close button while viewing current plan modal
  useEffect(() => {
    const body = document.body;
    if (!body) return;

    if (showVertexModal && modalMode === "view") {
      body.classList.add("view-plan-open");
      return () => body.classList.remove("view-plan-open");
    }

    body.classList.remove("view-plan-open");
  }, [showVertexModal, modalMode]);

  // ---------- FETCH PERFORMANCE VERTEX PACKAGE (for modal) ----------
  useEffect(() => {
    const fetchVertex = async () => {
      try {
        const data = await getPublicContent("package", {
          title: "Performance Vertex Overhaul",
        });
        setVertexPackage(preparePackage(data));
      } catch {
        console.error("Failed to fetch Performance Vertex package");
      }
    };
    fetchVertex();
  }, []);

  useEffect(() => {
    const fetchVertexEssentials = async () => {
      try {
        const data = await getPublicContent("package", {
          title: "Vertex Essentials",
        });
        setVertexEssentialsPackage(preparePackage(data));
      } catch {
        console.error("Failed to fetch Vertex Essentials package");
      }
    };
    fetchVertexEssentials();
  }, []);

  // ---------- FETCH CURRENT PLAN PACKAGE (for view plan modal) ----------
  useEffect(() => {
    if (!selectedPackage.title) return;
    let active = true;
    setPlanPackage(null);
    const fetchPlan = async () => {
      try {
        const data = await getPublicContent("package", {
          title: getPackageTitleAliases(selectedPackage.title),
        });
        if (active) setPlanPackage(preparePackage(data));
      } catch {
        console.error("Failed to fetch current package");
      }
    };
    fetchPlan();
    return () => {
      active = false;
    };
  }, [selectedPackage.title]);

  const times = useMemo(() => {
    if (!settings || !selectedDate || !localSlotMap) return [];

    const now = new Date();
    const dateKey = selectedDate.toDateString();
    const daySlots = localSlotMap[dateKey] || [];

    const bookedSet = new Set();
    const heldMap = new Map();

    (settings.bookedSlots || []).forEach((slot) => {
      if (!slot.startTimeUTC) return;
      if (slot.isHold) {
        if (slot.isExpiredHold) return;
        heldMap.set(slot.startTimeUTC, slot.holdId || "");
      } else {
        bookedSet.add(slot.startTimeUTC);
      }
    });

    // Build available slots with status
    const availableSlots = daySlots.map((slot) => {
      const isBooked = bookedSet.has(slot.slotId);
      const holdId = heldMap.get(slot.slotId);
      const isHeldOther = !!holdId && holdId !== myHold?.holdId;
      const isPast = slot.utcStart <= now;
      const disabled = isBooked || isHeldOther || isPast;

      return {
        ...slot,
        disabled,
        isBooked,
        isHeldOther,
        isExpiredHold: false,
        isAllowed: true,
        isPast,
        isUnavailable: false,
      };
    });

    // Build set of available slotIds for lookup
    const availableSlotIds = new Set(daySlots.map((s) => s.slotId));

    // Generate unavailable hours from all IST hours (0-23) for each host date
    const unavailableSlots = [];
    if (dateSlotMap) {
      Object.entries(dateSlotMap).forEach(([hostDateKey, availableHours]) => {
        const hostDate = new Date(hostDateKey);
        if (Number.isNaN(hostDate.getTime())) return;
        const availSet = new Set(availableHours || []);

        for (let h = 0; h < 24; h++) {
          if (availSet.has(h)) continue;
          const utcStart = getUtcFromHostLocal(
            hostDate.getFullYear(),
            hostDate.getMonth(),
            hostDate.getDate(),
            h
          );
          if (Number.isNaN(utcStart.getTime())) continue;
          const localDateKey = getLocalDateKey(utcStart, userTimeZone);
          if (localDateKey !== dateKey) continue;
          const slotId = `unavail-${hostDateKey}-${h}`;
          if (availableSlotIds.has(slotId)) continue;
          const localLabel = formatLocalTime(utcStart, userTimeZone);
          unavailableSlots.push({
            slotId,
            utcStart,
            localLabel,
            disabled: true,
            isBooked: false,
            isHeldOther: false,
            isAllowed: false,
            isPast: false,
            isUnavailable: true,
          });
        }
      });
    }

    const allSlots = [...availableSlots, ...unavailableSlots];
    allSlots.sort((a, b) => a.utcStart - b.utcStart);
    return allSlots;
  }, [settings, selectedDate, localSlotMap, dateSlotMap, myHold, userTimeZone]);

  const getDaySlotInfo = (dateObj) => {
    if (!settings || !localSlotMap) return null;

    const d = new Date(dateObj);
    d.setHours(0, 0, 0, 0);

    if (d < startOfToday) return null;

    const dateKey = d.toDateString();
    const daySlots = localSlotMap[dateKey] || [];
    if (!daySlots.length) return null;

    const bookedSet = new Set();
    const heldMap = new Map();

    (settings.bookedSlots || []).forEach((slot) => {
      if (!slot.startTimeUTC) return;
      if (slot.isHold) {
        heldMap.set(slot.startTimeUTC, slot.holdId || "");
      } else {
        bookedSet.add(slot.startTimeUTC);
      }
    });

    const now = new Date();

    let availableCount = 0;
    let totalConsidered = 0;

    daySlots.forEach((slot) => {
      const isBooked = bookedSet.has(slot.slotId);
      const holdId = heldMap.get(slot.slotId);
      const isHeldOther = !!holdId && holdId !== myHold?.holdId;
      const isPast = slot.utcStart <= now;
      const disabled = isBooked || isHeldOther || isPast;

      totalConsidered++;
      if (!disabled) availableCount++;
    });

    if (totalConsidered === 0) {
      return { color: "red" };
    }

    if (availableCount === 0) return { color: "red" };
    if (availableCount <= 5) return { color: "yellow" };
    if (availableCount > 5) return { color: "green" };

    return null;
  };

  // ---------- INITIAL DATE ----------
  useEffect(() => {
    if (settings && !selectedDate) {
      if (!localSlotMap) return;

      const nextDate = Object.keys(localSlotMap)
        .map((key) => new Date(key))
        .filter((d) => !Number.isNaN(d.getTime()) && d >= startOfToday)
        .sort((a, b) => a - b)[0];
      const initialDate = nextDate ? new Date(nextDate) : new Date(startOfToday);
      initialDate.setHours(0, 0, 0, 0);
      setSelectedDate(initialDate);
      setMonth(new Date(initialDate.getFullYear(), initialDate.getMonth(), 1));
    }
  }, [settings, selectedDate, localSlotMap, startOfToday]);

  // ---------- HELPERS ----------
  const handleChange = (e) => {
    if (isPaymentPendingHold) return;
    const { name, value } = e.target;
    const nextForm = { ...form, [name]: value };
    setForm(nextForm);
    clearErrorIfResolved(nextForm);
    const empty = isDraftEmpty(nextForm);
    if (empty) {
      clearDraftForPackage(getDraftKey(selectedPackage));
    } else {
      persistDraft({
        form: nextForm,
        selectedPackage: { ...selectedPackage },
      });
    }
  };

  useEffect(() => {
    if (draftLoading) return;
    if (isDraftEmpty(form)) {
      clearDraftForPackage(getDraftKey(selectedPackage));
    }
  }, [
    form.discord,
    form.email,
    form.specs,
    form.mainGame,
    form.notes,
    selectedPackage,
    draftLoading,
  ]);

  const handleDayClick = (day) => {
    if (isPaymentPendingHold) return;
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    date.setHours(0, 0, 0, 0);

    if (!isDateAllowed(date)) return;

    setSelectedDate(date);
    setSelectedSlot(null);
    setPreventHoldAutoload(false);
    persistDraft({
      form,
      selectedPackage: { ...selectedPackage },
    });
  };

  const handleEarliestSlotClick = () => {
    if (!earliestAvailableSlot || isPaymentPendingHold) return;
    const date = new Date(earliestAvailableSlot.localDate);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setSelectedDate(date);
    setSelectedSlot(earliestAvailableSlot);
    setPreventHoldAutoload(false);
    setErrorStep1("");
  };

  const holdLocalTimeLabel = useMemo(() => {
    if (!myHold) return "";
    const utcDate = getUtcDateFromHold(myHold);
    if (!utcDate) return "";
    return formatLocalTime(utcDate, userTimeZone);
  }, [myHold, userTimeZone]);
  const hasActiveHold =
    !!myHold &&
    holdCountdownMs !== null &&
    (holdCountdownMs > 0 || isPaymentPendingHold);
  hasActiveHoldRef.current = hasActiveHold;
  const reviewDateTimeLabel = useMemo(() => {
    if (!selectedSlot?.utcStart) return "";
    const utcStart = new Date(selectedSlot.utcStart);
    if (Number.isNaN(utcStart.getTime())) return "";
    const dateLabel = formatShortLocalDate(utcStart, userTimeZone);
    const timeLabel =
      formatLocalTime(utcStart, userTimeZone) || selectedSlot.localLabel;
    return `${dateLabel} · ${timeLabel} (${userTimeZone})`;
  }, [selectedSlot, userTimeZone]);
  const reviewBaseAmount = Math.max(0, toMoney(selectedPackage.price));
  const reviewDiscounts = useMemo(
    () =>
      calculateCheckoutDiscounts({
        baseAmount: reviewBaseAmount,
        referral: appliedReferral,
        coupon: appliedCoupon,
      }),
    [appliedCoupon, appliedReferral, reviewBaseAmount]
  );
  const reviewTotal =
    reviewBaseAmount > 0 ? formatUsd(reviewDiscounts.finalAmount) : "";

  const closeCodeEntry = () => {
    setCodeEntryOpen(false);
    setCodeInput("");
    setCodeError("");
  };

  const storeReferralSession = (code) => {
    try {
      if (code) {
        sessionStorage.setItem(REFERRAL_STORAGE_KEY, code);
      } else {
        sessionStorage.removeItem(REFERRAL_STORAGE_KEY);
      }
    } catch {
      console.error("Failed to persist referral session");
    }
  };

  const applyResolvedReferral = (referral) => {
    const safeReferral = sanitizeReferralForCheckout(referral);
    if (!safeReferral) {
      setCodeError(INVALID_CHECKOUT_CODE_MESSAGE);
      return;
    }
    const nextCoupon =
      appliedCoupon?.canCombineWithReferral === false
        ? null
        : sanitizeCouponForCheckout(appliedCoupon);
    setAppliedReferral(safeReferral);
    setAppliedCoupon(nextCoupon);
    setDismissedReferralCode("");
    storeReferralSession(safeReferral.code || codeInput.trim());
    persistCheckoutCodes({ referral: safeReferral, coupon: nextCoupon });
    closeCodeEntry();
  };

  const applyResolvedCoupon = (coupon) => {
    const safeCoupon = sanitizeCouponForCheckout(coupon);
    if (!safeCoupon) {
      setCodeError(INVALID_CHECKOUT_CODE_MESSAGE);
      return;
    }
    if (safeCoupon.canCombineWithReferral === false && appliedReferral) {
      setCodeError(
        "This coupon can't be used together with a referral discount. Remove the referral or use a different coupon."
      );
      return;
    }

    setAppliedCoupon(safeCoupon);
    persistCheckoutCodes({
      referral: sanitizeReferralForCheckout(appliedReferral),
      coupon: safeCoupon,
      dismissedCode: dismissedReferralCode,
    });
    closeCodeEntry();
  };

  const handleCodeSubmit = async (event) => {
    event.preventDefault();
    if (isPaymentPendingHold || validatingCode) return;

    const code = codeInput.trim();
    if (!code) {
      setCodeError("Enter a referral or coupon code.");
      return;
    }

    setValidatingCode(true);
    setCodeError("");

    try {
      const result = await resolveCheckoutCode(code, selectedPackage.title);
      if (!hasActiveHoldRef.current || isPaymentPendingHold) return;
      if (!result.ok) {
        setCodeError(result.error || INVALID_CHECKOUT_CODE_MESSAGE);
        return;
      }

      if (result.type === "referral") {
        applyResolvedReferral(result.value);
        return;
      }
      applyResolvedCoupon(result.value);
    } finally {
      setValidatingCode(false);
    }
  };

  const removeAppliedReferral = () => {
    if (isPaymentPendingHold) return;
    const removedCode = String(appliedReferral?.code || "").trim();
    autoReferralAttemptRef.current = "";
    setAppliedReferral(null);
    setDismissedReferralCode(removedCode);
    storeReferralSession("");
    persistCheckoutCodes({
      referral: null,
      coupon: sanitizeCouponForCheckout(appliedCoupon),
      dismissedCode: removedCode,
    });
  };

  const removeAppliedCoupon = () => {
    if (isPaymentPendingHold) return;
    setAppliedCoupon(null);
    persistCheckoutCodes({
      referral: sanitizeReferralForCheckout(appliedReferral),
      coupon: null,
      dismissedCode: dismissedReferralCode,
    });
  };

  useEffect(() => {
    if (
      !restoredCodeCandidates ||
      !hasActiveHold ||
      isPaymentPendingHold ||
      step !== 3
    ) {
      return;
    }

    let active = true;
    setValidatingCode(true);
    setCodeError("");

    const restoreValidatedCodes = async () => {
      let nextReferral = null;
      let nextCoupon = null;
      let nextDismissedCode = restoredCodeCandidates.dismissedCode || "";
      let invalidCodeFound = false;

      const applyResult = (result, sourceType, sourceCode) => {
        if (!result?.ok) {
          invalidCodeFound = true;
          if (sourceType === "referral") {
            nextDismissedCode = sourceCode;
          }
          return;
        }

        if (result.type === "referral") {
          const safeReferral = sanitizeReferralForCheckout(result.value);
          if (!safeReferral) {
            invalidCodeFound = true;
            return;
          }
          nextReferral = safeReferral;
          nextDismissedCode = "";
          if (nextCoupon?.canCombineWithReferral === false) {
            nextCoupon = null;
          }
          return;
        }

        const safeCoupon = sanitizeCouponForCheckout(result.value);
        if (
          !safeCoupon ||
          (safeCoupon.canCombineWithReferral === false && nextReferral)
        ) {
          invalidCodeFound = true;
          return;
        }
        nextCoupon = safeCoupon;
      };

      const referralCode = restoredCodeCandidates.referralCode;
      if (referralCode) {
        const result = await resolveCheckoutCode(
          referralCode,
          selectedPackage.title
        );
        if (!active || !hasActiveHoldRef.current) return;
        applyResult(result, "referral", referralCode);
      }

      const couponCode = restoredCodeCandidates.couponCode;
      if (couponCode && couponCode.toLowerCase() !== referralCode.toLowerCase()) {
        const result = await resolveCheckoutCode(
          couponCode,
          selectedPackage.title
        );
        if (!active || !hasActiveHoldRef.current) return;
        applyResult(result, "coupon", couponCode);
      }

      if (!active || !hasActiveHoldRef.current) return;
      setAppliedReferral(nextReferral);
      setAppliedCoupon(nextCoupon);
      setDismissedReferralCode(nextDismissedCode);
      storeReferralSession(nextReferral?.code || "");
      persistCheckoutCodes({
        referral: nextReferral,
        coupon: nextCoupon,
        dismissedCode: nextDismissedCode,
      });
      setRestoredCodeCandidates(null);

      if (invalidCodeFound) {
        setCodeEntryOpen(true);
        setCodeError(INVALID_CHECKOUT_CODE_MESSAGE);
      }
    };

    restoreValidatedCodes().finally(() => {
      if (active) setValidatingCode(false);
    });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasActiveHold,
    isPaymentPendingHold,
    restoredCodeCandidates,
    selectedPackage.title,
    step,
  ]);

  useEffect(() => {
    if (
      draftLoading ||
      restoredCodeCandidates ||
      step !== 3 ||
      !hasActiveHold ||
      isPaymentPendingHold ||
      appliedReferral
    ) {
      return;
    }

    const storedReferral = readReferralFromSession();
    const autoCode = referralQuery.code || storedReferral;
    if (
      !autoCode ||
      autoCode.toLowerCase() === dismissedReferralCode.toLowerCase()
    ) {
      return;
    }

    const attemptKey = `${selectedPackage.title}:${autoCode.toLowerCase()}`;
    if (autoReferralAttemptRef.current === attemptKey) return;
    autoReferralAttemptRef.current = attemptKey;
    let active = true;
    setValidatingCode(true);

    resolveCheckoutCode(autoCode, selectedPackage.title)
      .then((result) => {
        if (!active || !hasActiveHoldRef.current) return;
        if (!result?.ok) {
          const nextCoupon = sanitizeCouponForCheckout(appliedCoupon);
          setDismissedReferralCode(autoCode);
          storeReferralSession("");
          persistCheckoutCodes({
            referral: null,
            coupon: nextCoupon,
            dismissedCode: autoCode,
          });
          setCodeEntryOpen(true);
          setCodeInput("");
          setCodeError(INVALID_CHECKOUT_CODE_MESSAGE);
          return;
        }
        if (result.type === "coupon") {
          const safeCoupon = sanitizeCouponForCheckout(result.value);
          if (
            !safeCoupon ||
            (safeCoupon.canCombineWithReferral === false && appliedReferral)
          ) {
            return;
          }
          setAppliedCoupon(safeCoupon);
          persistCheckoutCodes({
            referral: sanitizeReferralForCheckout(appliedReferral),
            coupon: safeCoupon,
            dismissedCode: dismissedReferralCode,
          });
          return;
        }

        const safeReferral = sanitizeReferralForCheckout(result.value);
        if (!safeReferral) return;
        const nextCoupon =
          appliedCoupon?.canCombineWithReferral === false
            ? null
            : sanitizeCouponForCheckout(appliedCoupon);
        setAppliedReferral(safeReferral);
        setAppliedCoupon(nextCoupon);
        storeReferralSession(safeReferral.code || autoCode);
        persistCheckoutCodes({ referral: safeReferral, coupon: nextCoupon });
      })
      .catch(() => {})
      .finally(() => {
        if (active) setValidatingCode(false);
      });

    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    appliedReferral,
    dismissedReferralCode,
    draftLoading,
    hasActiveHold,
    isPaymentPendingHold,
    referralQuery.code,
    restoredCodeCandidates,
    selectedPackage.title,
    step,
  ]);

  const clearHoldState = (resetStep = true, clearStorage = true) => {
    hasActiveHoldRef.current = false;
    setMyHold(null);
    if (clearStorage) {
      sessionStorage.removeItem(HOLD_STORAGE_KEY);
    }
    setSelectedSlot(null);
    setHoldCountdownMs(null);
    if (resetStep) setStep(1);
    broadcastHold(null);
  };

  const getPaymentNavigationState = () => {
    const bookingData = readStoredCheckoutBooking();
    const backgroundLocation = location.state?.backgroundLocation || null;
    return {
      ...(bookingData ? { bookingData } : {}),
      ...(backgroundLocation ? { backgroundLocation } : {}),
    };
  };

  const returnToPayment = () => {
    navigate("/payment", { state: getPaymentNavigationState() });
  };

  const showCapturedPaymentResult = (data = {}) => {
    const status = String(data.status || "").trim().toLowerCase();
    const bookingId = String(data.bookingId || "").trim();
    const emailDispatchToken = String(data.emailDispatchToken || "").trim();
    if (
      !["booked", "email_partial"].includes(status) ||
      !bookingId ||
      !emailDispatchToken
    ) {
      returnToPayment();
      return;
    }

    const bookingConfirmation = { bookingId, emailDispatchToken };
    try {
      sessionStorage.setItem(
        BOOKING_CONFIRMATION_STORAGE_KEY,
        JSON.stringify(bookingConfirmation)
      );
      sessionStorage.removeItem(PAYMENT_SESSION_STORAGE_KEY);
      sessionStorage.removeItem(CHECKOUT_BOOKING_STORAGE_KEY);
    } catch {
      console.error("Failed to persist booking confirmation");
    }
    clearHoldState(true);
    const backgroundLocation = location.state?.backgroundLocation || null;
    navigate("/payment-success", {
      replace: true,
      state: {
        bookingConfirmation,
        ...(backgroundLocation ? { backgroundLocation } : {}),
      },
    });
  };

  const updateHoldPackage = (pkg) => {
    if (!myHold || isPaymentPendingHold) return;
    const updated = {
      ...myHold,
      packageTitle: pkg?.title || myHold.packageTitle,
      packagePrice: pkg?.price || myHold.packagePrice,
      packageTag: pkg?.tag || myHold.packageTag,
    };
    setMyHold(updated);
    try {
      sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      console.error("Failed to persist updated hold");
    }
    broadcastHold(updated);
  };

  // ---------- RELEASE HOLD (Optimistic Update) ----------
  const releaseHold = async (resetStep = true) => {
    if (!myHold) return;
    if (isPaymentPendingHold) {
      setErrorStep2(
        "Your payment session is already in progress. Return to payment to finish it."
      );
      return;
    }

    const holdIdToDelete = myHold.holdId;
    const holdTokenToDelete = myHold.holdToken;

    clearHoldState(resetStep);

    try {
      await fetch("/api/releaseHold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holdId: holdIdToDelete,
          holdToken: holdTokenToDelete,
        }),
      });
    } catch {
      console.error("Failed to release hold on server");
    }
  };

  const releasePaymentSession = async () => {
    if (!isPaymentPendingHold || releasingPayment) return;
    setReleasingPayment(true);
    setErrorStep2("");
    setPaymentReleaseStatus("");
    try {
      const stored = JSON.parse(
        sessionStorage.getItem(PAYMENT_SESSION_STORAGE_KEY) || "null"
      );
      const paymentAccessToken = String(stored?.paymentAccessToken || "").trim();
      if (!paymentAccessToken) {
        throw new Error("Return to payment once so the active session can be checked.");
      }
      const response = await fetch("/api/payment/cancel", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${paymentAccessToken}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      const data = await response.json().catch(() => ({}));
      if (data?.captured) {
        showCapturedPaymentResult(data);
        return;
      }
      if (!response.ok || data?.cancelled !== true) {
        throw new Error(data?.error || "The payment session could not be released.");
      }
      const refreshed = data.refreshedHold;
      if (!refreshed?.slotHoldId || !refreshed?.slotHoldToken) {
        clearHoldState(true);
        setErrorStep1("The reservation expired. Please choose the slot again.");
        return;
      }
      const nextHold = {
        ...myHold,
        holdId: refreshed.slotHoldId,
        holdToken: refreshed.slotHoldToken,
        expiresAt: refreshed.slotHoldExpiresAt,
        phase: "holding",
      };
      setMyHold(nextHold);
      sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(nextHold));
      const checkoutUpdated = updateStoredCheckoutHold(refreshed);
      sessionStorage.removeItem(PAYMENT_SESSION_STORAGE_KEY);
      broadcastHold(nextHold);
      setPaymentReleaseStatus(
        checkoutUpdated
          ? "Payment method released. You can choose another payment method."
          : "Payment method released. Review your booking details and submit again."
      );
    } catch (error) {
      setPaymentReleaseStatus("");
      setErrorStep2(error.message || "The payment session could not be released.");
    } finally {
      setReleasingPayment(false);
    }
  };

  // ---------- LOCK SLOT + GO TO STEP 2 ----------
  const handleLockAndGoNext = async () => {
    if (isPaymentPendingHold) {
      setErrorStep1("Your payment session is already in progress. Return to payment to finish it.");
      return;
    }
    if (!selectedDate || !selectedSlot) {
      setErrorStep1("Please select a date and time before continuing.");
      return;
    }

    if (lockingSlot) return;

    setErrorStep1("");
    setLockingSlot(true);

    let previousHoldId = null;
    let previousHoldToken = null;
    const selectedSlotId = selectedSlot.utcStart.toISOString();
    const isSameAsExisting =
      myHold && myHold.startTimeUTC === selectedSlotId;

    if (myHold && isSameAsExisting) {
      updateHoldPackage(selectedPackage);
      setStep(2);
      setLockingSlot(false);
      setPreventHoldAutoload(false);
      return;
    }

    if (myHold && !isSameAsExisting) {
      previousHoldId = myHold.holdId || null;
      previousHoldToken = myHold.holdToken || null;
      await releaseHold(false);
    }

    try {
      const body = {
        startTimeUTC: selectedSlotId,
        packageTitle: selectedPackage.title,
        previousHoldId,
        previousHoldToken,
      };

      const res = await fetch("/api/holdSlot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (!res.ok || !data.ok) {
        setErrorStep1(
          data.message ||
            "That slot was just taken by someone else. Please choose another time."
        );
        setSelectedSlot(null);
        return;
      }

      const newHold = {
        holdId: data.holdId,
        holdToken: data.holdToken,
        expiresAt: data.expiresAt,
        startTimeUTC: selectedSlotId,
        packageTitle: selectedPackage.title,
        packagePrice: selectedPackage.price,
        packageTag: selectedPackage.tag,
        phase: "active",
      };

      setMyHold(newHold);
      sessionStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(newHold));
      broadcastHold(newHold);

      const expiresIn =
        newHold.expiresAt && new Date(newHold.expiresAt).getTime() - Date.now();
      if (Number.isFinite(expiresIn)) {
        setHoldCountdownMs(Math.max(0, expiresIn));
      }
      setStep(2);
    } catch {
      console.error("Failed to reserve slot");
      setErrorStep1(
        "Could not reserve this slot. Please check your internet and try again."
      );
    } finally {
      setLockingSlot(false);
    }
  };

  // ---------- SUBMIT ----------
  const handleSubmit = () => {
    const validationError = getStep2Error();
    if (validationError) {
      setErrorStep2(validationError);
      setStep(2);
      return;
    }

    if (!selectedDate || !selectedSlot) {
      setStep(1);
      setErrorStep1("Please select a time slot before continuing.");
      return;
    }

    const holdExpired =
      myHold?.expiresAt && new Date(myHold.expiresAt) <= new Date();
    if (!myHold?.holdId || holdExpired) {
      setStep(1);
      setErrorStep1("Please reserve a slot before continuing.");
      return;
    }

    const displayDate =
      formatLocalDate(selectedSlot.utcStart, userTimeZone) ||
      selectedDate.toLocaleDateString(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
      });

    const displayTime =
      formatLocalTime(selectedSlot.utcStart, userTimeZone) ||
      selectedSlot.localLabel;

    const finalReferralCode = String(appliedReferral?.code || "").trim();
    const finalCouponCode = String(appliedCoupon?.code || "").trim();

    const payload = {
      displayDate,
      displayTime,

      localTimeZone: userTimeZone,
      localTimeLabel: displayTime,

      startTimeUTC: selectedSlot.utcStart.toISOString(),

      discord: form.discord.trim(),
      email: form.email.trim(),
      specs: form.specs.trim(),
      mainGame: form.mainGame.trim(),
      message: form.notes.trim(),

      packageTitle: selectedPackage.title,
      packagePrice: selectedPackage.price,

      status: "pending",

      // NEW: pass hold info to Payment -> createBooking
      slotHoldId: myHold?.holdId || null,
      slotHoldToken: myHold?.holdToken || null,
      slotHoldExpiresAt: myHold?.expiresAt || null,

      ...(finalReferralCode ? { referralCode: finalReferralCode } : {}),
      ...(finalCouponCode ? { couponCode: finalCouponCode } : {}),
    };

    try {
      persistDraft({
        form: { ...form },
        selectedPackage: { ...selectedPackage },
        checkoutCodes: {
          referral: sanitizeReferralForCheckout(appliedReferral),
          coupon: sanitizeCouponForCheckout(appliedCoupon),
          dismissedReferralCode,
        },
      });
    } catch {
      console.error("Failed to persist booking draft");
    }

    // Keep hold persisted for banner
    const backgroundLocation =
      location.state?.backgroundLocation || location.state || null;
    try {
      sessionStorage.setItem(
        CHECKOUT_BOOKING_STORAGE_KEY,
        JSON.stringify(payload)
      );
    } catch {
      console.error("Failed to persist checkout state");
    }

    navigate("/payment", {
      state: {
        bookingData: payload,
        ...(backgroundLocation ? { backgroundLocation } : {}),
      },
    });
  };

  const handleReviewBeforePayment = () => {
    const validationError = getStep2Error();
    if (validationError) {
      setErrorStep2(validationError);
      return;
    }
    setErrorStep2("");
    setPaymentReleaseStatus("");
    setStep(3);
  };

  const handlePay = () => {
    if (loading || validatingCode || restoredCodeCandidates) return;
    setLoading(true);
    handleSubmit();
    setLoading(false);
  };

  const warrantyCallout = getWarrantyCallout(selectedPackage);

  // ---------- CALENDAR DATA ----------
  const startOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const endOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const daysInMonth = Array.from(
    { length: endOfMonth.getDate() },
    (_, i) => i + 1
  );

  // --- ANIMATION VARIANTS FOR SLEEK MODAL ---
  const overlayVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: { duration: 0.3, ease: "easeOut" },
    },
    exit: {
      opacity: 0,
      transition: { duration: 0.2, ease: "easeIn" },
    },
  };

  const modalContainerVariants = {
    hidden: { opacity: 0, scale: 0.95, y: 15 },
    visible: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: {
        type: "spring",
        damping: 25,
        stiffness: 300,
        mass: 0.8,
        staggerChildren: 0.08, // This creates the sleek cascade effect
        delayChildren: 0.1,
      },
    },
    exit: {
      opacity: 0,
      scale: 0.95,
      y: 15,
      transition: { duration: 0.2 },
    },
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 15 },
    visible: {
      opacity: 1,
      y: 0,
      transition: { type: "spring", stiffness: 200, damping: 20 },
    },
  };

  return (
    <>
      <div
        className={`text-ink transition-opacity duration-300 ${
          pageFadeIn ? "opacity-100" : "opacity-0"
        }`}
      >
        {!settings ? (
          <div className="mt-20 flex flex-col items-center gap-3 text-center">
            <div className="text-accent">
              {settingsError || "Loading..."}
            </div>
            {settingsError && (
              <button
                type="button"
                onClick={() => setSettingsReloadKey((key) => key + 1)}
                className="rounded-lg border border-info-border bg-info-soft px-4 py-2 text-sm font-semibold text-info-text transition hover:bg-surface-hover-accent focus:outline-none focus:ring-2 focus:ring-[color:var(--color-focus-ring)]"
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <>
            {step === 1 && selectedPackage.title && (
              <div className="mb-8 max-w-lg mx-auto bg-surface-card border border-line-input rounded-xl p-6 text-center shadow-[0_0_15px_rgba(14,165,233,0.25)]">
                {selectedPackage.tag && (
                  <div className="mb-2">
                    <span className="bg-info text-accent-contrast text-xs font-semibold px-3 py-1 rounded-full shadow-info-soft">
                      {selectedPackage.tag}
                    </span>
                  </div>
                )}
                <h3 className="text-2xl font-bold text-accent">
                  {selectedPackage.title}
                </h3>
                <PriceDisplay pkg={selectedPackage} size="summary" className="mt-3" />
              </div>
            )}

            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                  className="max-w-3xl mx-auto bg-surface-card border border-line-input rounded-2xl p-8 text-center shadow-[0_0_25px_rgba(14,165,233,0.15)]"
                >
                  <BookingStepTracker step={1} />
                  <h3 className="text-accent text-lg font-semibold mb-2">
                    Select a Date and Time for Your Session
                  </h3>
                  <p className="text-xs text-accent mb-5">
                    Times are shown in{" "}
                    <span className="font-semibold">your local time</span> (
                    {userTimeZone}).
                  </p>
                  <HoldBanner
                    active={hasActiveHold}
                    countdownMs={holdCountdownMs}
                    isPaymentPending={isPaymentPendingHold}
                    localTimeLabel={holdLocalTimeLabel}
                    onRelease={() => releaseHold(true)}
                    className="mb-6 text-left"
                  />
                  {earliestAvailableSlot && (
                    <button
                      type="button"
                      onClick={handleEarliestSlotClick}
                      className="mb-6 rounded-lg border border-info-border bg-info-soft px-4 py-2 text-sm font-semibold text-info-text transition hover:bg-surface-hover-accent"
                    >
                      Earliest available:{" "}
                      {formatShortLocalDate(
                        earliestAvailableSlot.utcStart,
                        userTimeZone
                      )}{" "}
                      at {earliestAvailableSlot.localLabel}
                    </button>
                  )}

                  <div
                    className={`flex flex-col gap-8 justify-center ${
                      isMobile ? "" : "sm:flex-row"
                    }`}
                  >
                    <div>
                      <div className="flex justify-between items-center mb-4">
                        <button
                          onClick={() =>
                            setMonth(
                              new Date(
                                month.getFullYear(),
                                month.getMonth() - 1,
                                1
                              )
                            )
                          }
                          className="text-accent hover:text-accent transition"
                        >
                          ‹
                        </button>
                        <h4 className="text-xl font-semibold text-info-text">
                          {month.toLocaleString("default", {
                            month: "long",
                          })}{" "}
                          {month.getFullYear()}
                        </h4>
                        <button
                          onClick={() =>
                            setMonth(
                              new Date(
                                month.getFullYear(),
                                month.getMonth() + 1,
                                1
                              )
                            )
                          }
                          className="text-accent hover:text-accent transition"
                        >
                          ›
                        </button>
                      </div>

                      <div className="grid grid-cols-7 gap-2 text-sm text-accent mb-2">
                        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                          (d) => (
                            <div key={d} className="font-semibold text-accent">
                              {d}
                            </div>
                          )
                        )}
                      </div>

                      <div className="grid grid-cols-7 gap-2 text-sm">
                        {Array(startOfMonth.getDay())
                          .fill(null)
                          .map((_, i) => (
                            <div key={`empty-${i}`} />
                          ))}

                        {daysInMonth.map((day) => {
                          const date = new Date(
                            month.getFullYear(),
                            month.getMonth(),
                            day
                          );
                          date.setHours(0, 0, 0, 0);

                          const disabled = !isDateAllowed(date);
                          const isSelected =
                            selectedDate && isSameDay(date, selectedDate);

                          const slotInfo = getDaySlotInfo(date);
                          let dotClass = "";
                          if (slotInfo?.color === "red") {
                            dotClass =
                              "bg-danger shadow-danger-soft";
                          } else if (slotInfo?.color === "yellow") {
                            dotClass =
                              "bg-warning shadow-[0_0_6px_rgba(251,191,36,0.55)]";
                          } else if (slotInfo?.color === "green") {
                            dotClass =
                              "bg-success shadow-success-soft";
                          }

                          return (
                            <button
                              key={day}
                              disabled={disabled}
                              onClick={() => handleDayClick(day)}
                              className={`p-2 rounded-lg transition-all duration-200 flex flex-col items-center justify-center ${
                                isSelected
                                  ? "bg-accent-strong text-accent-contrast shadow-glow-soft"
                                  : disabled
                                  ? "text-ink-muted cursor-not-allowed"
                                  : "hover:bg-surface-hover-accent text-info-text"
                              }`}
                            >
                              <span>{day}</span>
                              {slotInfo?.color && (
                                <span
                                  className={`mt-0.5 h-1.5 w-1.5 rounded-full ${dotClass}`}
                                />
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-3 flex flex-wrap justify-center gap-3 text-[10px] text-accent">
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-success shadow-success-soft" />
                          <span>Fully Available</span>
                        </div>
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-warning shadow-[0_0_6px_rgba(251,191,36,0.55)]" />
                          <span>Limited Slots</span>
                        </div>
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-danger shadow-danger-soft" />
                          <span>Fully Booked</span>
                        </div>
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-purple-400 shadow-[0_0_6px_rgba(192,132,252,0.9)]" />
                          <span>Temporarily Reserved</span>
                        </div>
                      </div>
                      <p className="mt-2 text-[10px] font-bold text-info-text text-center">
                        All times shown are in your local timezone ({userTimeZone.replace(/_/g, " ")})
                      </p>
                    </div>

                    {selectedDate && (
                      <div className="flex-1">
                        <p className="text-info-text mb-3 font-semibold">
                          Availability for{" "}
                          {selectedDate.toLocaleDateString(undefined, {
                            weekday: "long",
                            month: "long",
                            day: "numeric",
                          })}
                        </p>

                        <div
                          className={`grid gap-3 ${
                            isMobile
                              ? "grid-cols-2"
                              : "grid-cols-2 sm:grid-cols-3"
                          }`}
                        >
                          {times.map((t) => {
                            const isMyHold =
                              myHold && myHold.startTimeUTC === t.slotId;

                            return (
                              <button
                                key={t.slotId}
                                onClick={() => {
                                  if (isMyHold) {
                                    setSelectedSlot(t);
                                    setPreventHoldAutoload(false);
                                    return;
                                  }
                                  if (
                                    !t.disabled &&
                                    !t.isBooked &&
                                    !t.isHeldOther
                                  ) {
                                    setSelectedSlot(t);
                                    setPreventHoldAutoload(false);
                                  }
                                }}
                                disabled={t.disabled && !isMyHold}
                                className={`py-2 rounded-lg border transition-all duration-200 ${
                                  t.isUnavailable
                                    ? "bg-surface-input border-line-soft text-ink-muted cursor-not-allowed opacity-60"
                                    : t.isExpiredHold
                                    ? "bg-surface-input border-line-soft text-ink-muted cursor-not-allowed line-through opacity-50"
                                    : t.isBooked
                                    ? "bg-danger-soft border-danger-border text-danger-text cursor-not-allowed"
                                    : t.isHeldOther
                                    ? "bg-purple-900/40 border-purple-700/50 text-purple-300 cursor-not-allowed"
                                    : isMyHold
                                    ? "bg-purple-900/50 border-purple-500/60 text-purple-100 shadow-[0_0_14px_rgba(168,85,247,0.7)] hover:border-purple-400 hover:bg-purple-800/50"
                                    : t.disabled
                                    ? "bg-surface-input text-ink-muted border-line-soft cursor-not-allowed"
                                    : selectedSlot?.slotId === t.slotId
                                    ? "bg-accent-strong text-accent-contrast border-info-border shadow-glow-soft"
                                    : "border-line-input hover:border-info-border hover:bg-surface-hover-accent"
                                }`}
                              >
                                {t.localLabel}
                              </button>
                            );
                          })}
                        </div>
                        <p className="mt-4 text-xs text-accent">
                          {REASSURANCE_COPY}
                        </p>
                      </div>
                    )}
                  </div>

                  <div
                    className={`flex flex-col items-center justify-center gap-4 mt-10 ${
                      isMobile ? "" : "sm:flex-row"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setModalMode("view");
                        setModalPackage(planPackage || selectedPackage);
                        setShowVertexModal(true);
                      }}
                      className={`glow-button w-full sm:w-64 py-3 rounded-lg font-semibold text-lg transition-all duration-300 inline-flex items-center justify-center gap-2 ${
                        isMobile ? "" : ""
                      }`}
                    >
                      View My Plan
                      <span className="glow-line glow-line-top" />
                      <span className="glow-line glow-line-right" />
                      <span className="glow-line glow-line-bottom" />
                      <span className="glow-line glow-line-left" />
                    </button>

                    <button
                      onClick={handleLockAndGoNext}
                      aria-disabled={
                        !selectedDate || !selectedSlot || lockingSlot
                      }
                      className={`glow-button w-full sm:w-64 py-3 rounded-lg font-semibold text-lg transition-all duration-300 ${
                        !selectedDate || !selectedSlot || lockingSlot
                          ? "opacity-60"
                          : ""
                      } ${isMobile ? "" : ""}`}
                    >
                      {lockingSlot ? "Reserving..." : "Next"}
                      <span className="glow-line glow-line-top" />
                      <span className="glow-line glow-line-right" />
                      <span className="glow-line glow-line-bottom" />
                      <span className="glow-line glow-line-left" />
                    </button>
                  </div>

                  {errorStep1 && (
                    <p role="alert" className="text-danger-text mt-3 text-sm">{errorStep1}</p>
                  )}
                </motion.div>
              )}

              {step === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                  className="max-w-4xl mx-auto bg-surface-card border border-line-input rounded-2xl p-8 shadow-[0_0_25px_rgba(14,165,233,0.15)]"
                >
                  <BookingStepTracker step={2} />
                  <HoldBanner
                    active={hasActiveHold}
                    countdownMs={holdCountdownMs}
                    isPaymentPending={isPaymentPendingHold}
                    localTimeLabel={holdLocalTimeLabel}
                    onRelease={() => releaseHold(true)}
                    className="mb-6"
                  />

                  <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-line-input bg-surface-input px-4 py-3 text-left">
                    <div>
                      <p className="font-semibold text-info-text">
                        {selectedPackage.title}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {reviewDateTimeLabel ||
                          holdLocalTimeLabel ||
                          "Choose a slot"}
                      </p>
                    </div>
                    <p className="text-lg font-bold text-accent">
                      {selectedPackage.price}
                    </p>
                  </div>

                  <div className="space-y-4">
                    <input
                      name="discord"
                      aria-label="Discord username"
                      placeholder="Discord (e.g. Servi#1234 or @Servi)"
                      onChange={handleChange}
                      value={form.discord}
                      className="w-full bg-surface-input border border-line-input rounded-lg p-3 focus:outline-none focus:border-info-border transition"
                    />
                    <input
                      name="email"
                      aria-label="Booking email"
                      type="email"
                      placeholder="Email"
                      onChange={handleChange}
                      value={form.email}
                      className="w-full bg-surface-input border border-line-input rounded-lg p-3 focus:outline-none focus:border-info-border transition"
                    />
                    <input
                      name="specs"
                      aria-label="PC specifications"
                      placeholder="PC Specs"
                      onChange={handleChange}
                      value={form.specs}
                      className="w-full bg-surface-input border border-line-input rounded-lg p-3 focus:outline-none focus:border-info-border transition"
                    />
                    <input
                      name="mainGame"
                      aria-label="Main game or application"
                      placeholder="Main use case (Game/Apps)"
                      onChange={handleChange}
                      value={form.mainGame}
                      className="w-full bg-surface-input border border-line-input rounded-lg p-3 focus:outline-none focus:border-info-border transition"
                    />
                    <textarea
                      name="notes"
                      aria-label="Extra booking requirements"
                      placeholder="Any extra requirements?"
                      onChange={handleChange}
                      value={form.notes}
                      className="w-full bg-surface-input border border-line-input rounded-lg p-3 h-24 focus:outline-none focus:border-info-border transition"
                    />
                  </div>

                  <p className="mt-6 text-xs text-accent">
                    Please read the FAQ before booking — it answers everything you
                    need to know.
                  </p>

                  <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setStep(1)}
                      className="w-full min-w-0 bg-surface-input hover:bg-surface-hover py-3 rounded-lg font-semibold transition"
                    >
                      Back
                    </button>
                    <button
                      type="button"
                      onClick={handleReviewBeforePayment}
                      className={`glow-button w-full min-w-0 py-3 rounded-lg font-semibold transition inline-flex items-center justify-center gap-2 ${
                        !isStep2Complete ? "opacity-60 cursor-not-allowed" : ""
                      }`}
                    >
                      Review before payment
                      <span className="glow-line glow-line-top" />
                      <span className="glow-line glow-line-right" />
                      <span className="glow-line glow-line-bottom" />
                      <span className="glow-line glow-line-left" />
                    </button>
                  </div>
                  {errorStep2 && (
                    <p role="alert" className="mt-3 text-sm text-danger-text">{errorStep2}</p>
                  )}
                </motion.div>
              )}

              {step === 3 && (
                <motion.div
                  key="step3"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.3, ease: "easeInOut" }}
                  className="max-w-3xl mx-auto bg-surface-card border border-line-input rounded-2xl p-8 shadow-[0_0_25px_rgba(14,165,233,0.15)]"
                >
                  <BookingStepTracker step={3} />
                  <HoldBanner
                    active={hasActiveHold}
                    countdownMs={holdCountdownMs}
                    isPaymentPending={isPaymentPendingHold}
                    localTimeLabel={holdLocalTimeLabel}
                    onRelease={() => releaseHold(true)}
                    className="mb-6"
                  />

                  <div className="rounded-xl border border-line-input bg-surface-card p-5">
                    <div className="flex items-center justify-between gap-4 border-b border-line-input pb-4">
                      <h3 className="text-lg font-semibold text-info-text">
                        Review your booking
                      </h3>
                      {!isPaymentPendingHold && (
                        <button
                          type="button"
                          onClick={() => setStep(2)}
                          className="text-xs font-semibold text-accent underline underline-offset-2 transition hover:text-info-text"
                        >
                          Edit details
                        </button>
                      )}
                    </div>
                    <dl className="divide-y divide-line-input text-left text-sm">
                      <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                        <dt className="text-ink-muted">Package</dt>
                        <dd className="font-semibold text-ink sm:text-right">
                          {selectedPackage.title}
                        </dd>
                      </div>
                      <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                        <dt className="text-ink-muted">Warranty</dt>
                        <dd className="break-words text-ink sm:text-right">
                          {warrantyCallout.title}
                        </dd>
                      </div>
                      <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr_auto] sm:items-center">
                        <dt className="text-ink-muted">Date &amp; time</dt>
                        <dd className="font-semibold text-ink sm:text-right">
                          {reviewDateTimeLabel || "Not selected"}
                        </dd>
                        {!isPaymentPendingHold && (
                          <button
                            type="button"
                            onClick={() => setStep(1)}
                            className="justify-self-start text-xs font-semibold text-accent underline underline-offset-2 transition hover:text-info-text sm:justify-self-end"
                          >
                            Edit
                          </button>
                        )}
                      </div>
                      <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                        <dt className="text-ink-muted">Discord</dt>
                        <dd className="break-words text-ink sm:text-right">
                          {form.discord}
                        </dd>
                      </div>
                      <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                        <dt className="text-ink-muted">Email</dt>
                        <dd className="break-words text-ink sm:text-right">
                          {form.email}
                        </dd>
                      </div>
                      <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                        <dt className="text-ink-muted">PC specs</dt>
                        <dd className="whitespace-pre-wrap break-words text-ink sm:text-right">
                          {form.specs}
                        </dd>
                      </div>
                      <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                        <dt className="text-ink-muted">Main game/app</dt>
                        <dd className="break-words text-ink sm:text-right">
                          {form.mainGame}
                        </dd>
                      </div>
                      {form.notes.trim() && (
                        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]">
                          <dt className="text-ink-muted">Extra requirements</dt>
                          <dd className="whitespace-pre-wrap break-words text-ink sm:text-right">
                            {form.notes}
                          </dd>
                        </div>
                      )}
                      {appliedReferral && (
                        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:items-center">
                          <dt className="text-ink-muted">Referral</dt>
                          <dd className="flex flex-wrap items-center gap-2 font-semibold text-ink sm:justify-end sm:text-right">
                            <span>
                              {appliedReferral.code} · −
                              {formatUsd(
                                reviewDiscounts.referralDiscountAmount
                              )}
                            </span>
                            {!isPaymentPendingHold && (
                              <button
                                type="button"
                                onClick={removeAppliedReferral}
                                aria-label={`Remove referral code ${appliedReferral.code}`}
                                className="text-sm font-semibold text-ink-muted transition hover:text-danger-text"
                              >
                                ×
                              </button>
                            )}
                          </dd>
                        </div>
                      )}
                      {appliedCoupon && (
                        <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:items-center">
                          <dt className="text-ink-muted">Coupon</dt>
                          <dd className="flex flex-wrap items-center gap-2 font-semibold text-ink sm:justify-end sm:text-right">
                            <span>
                              {appliedCoupon.code} · −
                              {formatUsd(reviewDiscounts.couponDiscountAmount)}
                            </span>
                            {!isPaymentPendingHold && (
                              <button
                                type="button"
                                onClick={removeAppliedCoupon}
                                aria-label={`Remove coupon code ${appliedCoupon.code}`}
                                className="text-sm font-semibold text-ink-muted transition hover:text-danger-text"
                              >
                                ×
                              </button>
                            )}
                          </dd>
                        </div>
                      )}
                      {!isPaymentPendingHold && (
                        <div className="py-3">
                          <dt className="sr-only">
                            Referral or coupon code
                          </dt>
                          <dd>
                            {!codeEntryOpen ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setCodeEntryOpen(true);
                                  setCodeError("");
                                }}
                                className="text-xs font-semibold text-accent underline underline-offset-2 transition hover:text-info-text"
                              >
                                Have a referral or coupon code?
                              </button>
                            ) : (
                              <form onSubmit={handleCodeSubmit}>
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                                  <label
                                    htmlFor="booking-review-code"
                                    className="sr-only"
                                  >
                                    Referral or coupon code
                                  </label>
                                  <input
                                    id="booking-review-code"
                                    value={codeInput}
                                    onChange={(event) => {
                                      setCodeInput(event.target.value);
                                      if (codeError) setCodeError("");
                                    }}
                                    disabled={
                                      validatingCode || !!restoredCodeCandidates
                                    }
                                    aria-invalid={codeError ? "true" : "false"}
                                    aria-describedby={
                                      codeError
                                        ? "booking-review-code-error"
                                        : undefined
                                    }
                                    autoFocus
                                    placeholder="Enter code"
                                    className="min-w-0 flex-1 rounded-lg border border-line-input bg-surface-input p-3 text-sm outline-none transition focus:border-info-border disabled:cursor-wait disabled:opacity-60"
                                  />
                                  <button
                                    type="submit"
                                    disabled={
                                      validatingCode || !!restoredCodeCandidates
                                    }
                                    className="rounded-lg border border-line-input bg-surface-input px-4 py-3 text-sm font-semibold text-ink transition hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
                                  >
                                    {validatingCode ? "Checking..." : "Apply"}
                                  </button>
                                </div>
                                {codeError && (
                                  <p
                                    id="booking-review-code-error"
                                    role="alert"
                                    className="mt-2 text-sm text-danger-text"
                                  >
                                    {codeError}
                                  </p>
                                )}
                              </form>
                            )}
                          </dd>
                        </div>
                      )}
                      <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr] sm:items-center">
                        <dt className="font-semibold text-ink">Total</dt>
                        <dd className="text-lg font-bold text-accent sm:text-right">
                          {reviewTotal || "Confirmed on payment page"}
                        </dd>
                      </div>
                    </dl>
                  </div>

                  <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
                    {isPaymentPendingHold ? (
                      <>
                        <button
                          type="button"
                          onClick={releasePaymentSession}
                          disabled={releasingPayment}
                          className="w-full min-w-0 rounded-lg border border-danger-border bg-danger-soft py-3 font-semibold text-danger-text transition hover:bg-surface-hover disabled:cursor-wait disabled:opacity-60"
                        >
                          {releasingPayment
                            ? "Checking payment..."
                            : "Release payment"}
                        </button>
                        <button
                          type="button"
                          onClick={returnToPayment}
                          className="glow-button inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-lg py-3 font-semibold transition"
                        >
                          Return to payment
                          <span className="glow-line glow-line-top" />
                          <span className="glow-line glow-line-right" />
                          <span className="glow-line glow-line-bottom" />
                          <span className="glow-line glow-line-left" />
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => setStep(2)}
                          className="w-full min-w-0 bg-surface-input hover:bg-surface-hover py-3 rounded-lg font-semibold transition"
                        >
                          Back
                        </button>
                        <button
                          type="button"
                          onClick={handlePay}
                          disabled={
                            validatingCode || !!restoredCodeCandidates
                          }
                          className={`glow-button inline-flex w-full min-w-0 items-center justify-center gap-2 rounded-lg py-3 font-semibold transition ${
                            loading || validatingCode || restoredCodeCandidates
                              ? "cursor-wait opacity-60"
                              : ""
                          }`}
                        >
                          {loading
                            ? "Preparing payment..."
                            : validatingCode || restoredCodeCandidates
                            ? "Checking code..."
                            : reviewTotal
                            ? `Pay ${reviewTotal}`
                            : "Continue to payment"}
                          <span className="glow-line glow-line-top" />
                          <span className="glow-line glow-line-right" />
                          <span className="glow-line glow-line-bottom" />
                          <span className="glow-line glow-line-left" />
                        </button>
                      </>
                    )}
                  </div>
                  {!isPaymentPendingHold && (
                    <p className="mt-3 text-center text-xs text-ink-muted">
                      No charge until you confirm on the payment page.
                    </p>
                  )}
                  {paymentReleaseStatus && (
                    <p className="mt-3 text-sm text-success-text">
                      {paymentReleaseStatus}
                    </p>
                  )}
                  {errorStep2 && (
                    <p role="alert" className="mt-3 text-sm text-danger-text">{errorStep2}</p>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </div>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {showVertexModal && (
              <motion.div
                className={`fixed inset-0 z-[100] ${
                  modalMode === "view" ? "bg-transparent" : "bg-black/60"
                } backdrop-blur-lg flex items-center justify-center px-4`}
                variants={overlayVariants}
                initial="hidden"
                animate="visible"
                exit="exit"
                onClick={() => {
                  document.body.classList.remove("is-modal-blur");
                  setShowVertexModal(false);
                }}
              >
                <motion.div
                  variants={modalContainerVariants}
                  // We don't set initial/animate here because they inherit from the parent,
                  // but since we defined specific variants for the children, it works automatically.
                  className="relative w-full max-w-md bg-panel border border-info-border rounded-2xl shadow-glow-strong p-6 text-center transition-all duration-500 ease-in-out hover:shadow-glow-strong"
                  onClick={(e) => e.stopPropagation()}
                >
                  <motion.button
                    aria-label="Close"
                    variants={itemVariants}
                    className="absolute right-3 top-3 text-info-text hover:text-white transition text-2xl z-10"
                    onClick={() => {
                      document.body.classList.remove("is-modal-blur");
                      setShowVertexModal(false);
                    }}
                  >
                    ×
                  </motion.button>

                  <motion.div variants={itemVariants}>
                    <div className="inline-flex items-center px-4 py-1.5 rounded-full text-xs font-semibold text-accent-contrast bg-info shadow-info-soft mb-4">
                      {displayPackage?.tag ||
                        "For All Budget, Mid-Ranged and High End PCs"}
                    </div>
                  </motion.div>

                  <motion.h3
                    variants={itemVariants}
                    className="text-2xl font-bold text-info-text"
                  >
                    {displayPackage?.title || DEFAULT_VERTEX_PACKAGE.title}
                  </motion.h3>

                  <motion.div
                    variants={itemVariants}
                    className="mt-2"
                  >
                    <PriceDisplay
                      pkg={displayPackage || DEFAULT_VERTEX_PACKAGE}
                      size="modal"
                    />
                  </motion.div>

                  <motion.ul className="mt-4 space-y-2 text-sm text-info-text text-left">
                    {(displayPackage?.features &&
                    displayPackage.features.length > 0
                      ? displayPackage.features
                      : [
                          "Guaranteed boost in performance (latency, 1% lows, or average FPS)",
                          "30 day warranty",
                          "2-4 hour completion time",
                          "Same day availability",
                          "Overclocking of CPU, GPU, and RAM (Timings)",
                          "Diagnosing issues and full system inspection",
                          "Hidden BIOS tuning",
                          "Smooth frametimes",
                          "Benchmark guaranteed results",
                          "Fan curves, sound tuning, and input latency-driven adjustments",
                          "Proper core allocation and game process prioritization",
                          "Network driver tuning",
                          "90 day warranty plus future support at discretion",
                        ]
                    ).map((text, i) => (
                      <motion.li
                        key={text + i}
                        variants={itemVariants}
                        className="flex items-start gap-2"
                      >
                        <span className="text-accent mt-0.5">-</span>
                        <span className="flex-1">
                          {renderFeatureWithUpgradeLink(text)}
                        </span>
                      </motion.li>
                    ))}
                  </motion.ul>

                  {modalMode !== "view" && (
                    <motion.div variants={itemVariants}>
                      <button
                        type="button"
                        onClick={() => {
                          document.body.classList.remove("is-modal-blur");
                          setShowVertexModal(false);
                          setErrorStep2("");
                          setPreventHoldAutoload(true);
                          setStep(1);
                          setSelectedDate(null);
                          setSelectedSlot(null);
                          try {
                            const nextPackage = {
                              title:
                                displayPackage?.title ||
                                DEFAULT_VERTEX_PACKAGE.title,
                              price:
                                displayPackage?.price ||
                                DEFAULT_VERTEX_PACKAGE.price,
                              tag: displayPackage?.tag || "",
                            };
                            persistDraft({
                              form: { ...form },
                              selectedPackage: nextPackage,
                            });
                            persistBookingPackageSelection(nextPackage);
                          } catch {
                            console.error("Failed to store booking form draft");
                          }
                          navigate(
                            "/booking",
                            location.state?.backgroundLocation
                              ? {
                                  state: {
                                    backgroundLocation:
                                      location.state.backgroundLocation,
                                    bookingPackage: {
                                      title:
                                        displayPackage?.title ||
                                        DEFAULT_VERTEX_PACKAGE.title,
                                      price:
                                        displayPackage?.price ||
                                        DEFAULT_VERTEX_PACKAGE.price,
                                      tag: displayPackage?.tag || "",
                                    },
                                  },
                                }
                              : {
                                  state: {
                                    bookingPackage: {
                                      title:
                                        displayPackage?.title ||
                                        DEFAULT_VERTEX_PACKAGE.title,
                                      price:
                                        displayPackage?.price ||
                                        DEFAULT_VERTEX_PACKAGE.price,
                                      tag: displayPackage?.tag || "",
                                    },
                                  },
                                }
                          );
                        }}
                        className="glow-button w-full mt-6 py-3 rounded-lg font-semibold text-white shadow-[0_0_20px_rgba(56,189,248,0.4)] inline-flex items-center justify-center gap-2 opacity-90 hover:opacity-100"
                        style={{ transition: "opacity 0.9s ease-in-out" }}
                      >
                        {displayPackage?.buttonText || "Book Now"}
                        <span className="glow-line glow-line-top" />
                        <span className="glow-line glow-line-right" />
                        <span className="glow-line glow-line-bottom" />
                        <span className="glow-line glow-line-left" />
                      </button>
                    </motion.div>
                  )}
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body
        )}
    </>
  );
}
