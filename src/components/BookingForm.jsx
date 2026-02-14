import React, { useEffect, useMemo, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { client } from "../sanityClient";
import { useLocation, useNavigate, Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";


const IST_OFFSET_MINUTES = 330;
const FORM_PREFILL_KEY = "booking_form_prefill";
const HOLD_STORAGE_KEY = "my_slot_hold";
const BOOKING_DRAFT_KEY = "booking_draft";
const SESSION_STATE_KEY = "booking_modal_state";
const REFERRAL_STORAGE_KEY = "referral_session";
const readReferralFromSession = () => {
  try {
    return sessionStorage.getItem(REFERRAL_STORAGE_KEY) || "";
  } catch {
    return "";
  }
};
const getDraftKey = (pkg) => (pkg?.title ? pkg.title : "_default");
const isDraftEmpty = (formObj, moboId, ramId, customMobo, customRam) =>
  !formObj.discord.trim() &&
  !formObj.email.trim() &&
  !formObj.specs.trim() &&
  !formObj.mainGame.trim() &&
  !formObj.notes.trim() &&
  !moboId &&
  !ramId &&
  !customMobo.trim() &&
  !customRam.trim();

// Read query params
function useQuery() {
  const { search } = useLocation();
  return new URLSearchParams(search);
}

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

const fetchWithRetry = async (query, params = {}, attempts = 3, delayMs = 250) => {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await client.fetch(query, params);
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
  throw lastErr;
};

const broadcastHold = (payload) => {
  try {
    window.dispatchEvent(new CustomEvent("hold-state", { detail: payload }));
  } catch (e) {
    console.error("Failed to broadcast hold state", e);
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
    const titleKey = normalizePackageKey(entry?.package?.title);
    if (!titleKey) return;
    const slots = normalizeDateSlots(entry?.dateSlots);
    if (!Object.keys(slots).length) return;
    map[titleKey] = slots;
  });
  return map;
};

const getUtcDateFromHold = (hold) => {
  if (!hold?.startTimeUTC) return null;
  const fromStart = new Date(hold.startTimeUTC);
  return Number.isNaN(fromStart.getTime()) ? null : fromStart;
};

function XocDropdown({
  label,
  items,
  value,
  onChange,
  placeholder = "Select...",
  emptyMessage = "No options found",
  getId,
  getLabel,
  customOptionId,
  customOptionLabel,
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const wrapperRef = useRef(null);
  const isCustomSelected = value === customOptionId;

  // close on outside click
  useEffect(() => {
    function handleClick(e) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
    } else {
      document.removeEventListener("mousedown", handleClick);
    }
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.toLowerCase();
    return items.filter((item) => getLabel(item).toLowerCase().includes(q));
  }, [items, search, getLabel]);

  const selectedItem = items.find((i) => getId(i) === value);
  const hasSelection = Boolean(selectedItem || isCustomSelected);
  const displayText = selectedItem
    ? getLabel(selectedItem)
    : isCustomSelected
    ? customOptionLabel
    : placeholder;

  return (
    <div className="text-left relative" ref={wrapperRef}>
      {label && (
        <label className="block text-xs font-semibold text-sky-400 mb-1">
          {label}
        </label>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full bg-[#020617] border border-sky-700/60 rounded-lg px-3 py-2.5 text-sm flex items-center justify-between gap-2 focus:outline-none focus:border-sky-400"
      >
        <span className={hasSelection ? "" : "text-slate-500"}>
          {displayText}
        </span>
        <span className="text-sky-400 text-xs">▾</span>
      </button>

      {open && (
        <div className="absolute mt-1 w-full bg-[#020617] border border-sky-700/70 rounded-lg shadow-xl z-30 overflow-hidden">
          <div className="border-b border-sky-800/60">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              placeholder="Search..."
              className="w-full bg-transparent px-3 py-2 text-xs text-sky-100 placeholder-slate-500 focus:outline-none"
            />
          </div>

          <div className="max-h-56 overflow-y-auto text-sm">
            {filtered.length === 0 ? (
              <div className="px-3 py-2 text-xs text-slate-400 border-b border-sky-800/60">
                {emptyMessage}
              </div>
            ) : (
              filtered.map((item) => {
                const id = getId(item);
                const labelText = getLabel(item);
                const isSelected = id === value;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      onChange(id);
                      setOpen(false);
                    }}
                    className={`w-full text-left px-3 py-2 text-xs sm:text-sm transition ${
                      isSelected
                        ? "bg-sky-700/70 text-sky-50"
                        : "hover:bg-sky-700/40 text-sky-100"
                    }`}
                  >
                    {labelText}
                  </button>
                );
              })
            )}

            {customOptionId && customOptionLabel && (
              <button
                type="button"
                onClick={() => {
                  onChange(customOptionId);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-xs sm:text-sm text-sky-100 hover:bg-sky-700/40 transition border-t border-sky-800/60"
              >
                {customOptionLabel}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Accepts isMobile prop from BookingModal to force layout styles
export default function BookingForm({ isMobile }) {
  const location = useLocation();
  const q = useQuery();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [settings, setSettings] = useState(null);

  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedSlot, setSelectedSlot] = useState(null);

  const [month, setMonth] = useState(new Date());
  const [loading, setLoading] = useState(false);
  const [errorStep1, setErrorStep1] = useState("");
  const [errorStep2, setErrorStep2] = useState("");

  const [userTimeZone] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  });

  const [form, setForm] = useState({
    discord: "",
    email: "",
    specs: "",
    mainGame: "",
    notes: "",
  });

  // XOC hardware data loaded from /api/xocParts
  const [xocMotherboards, setXocMotherboards] = useState([]);
  const [xocRams, setXocRams] = useState([]);
  const [xocMoboId, setXocMoboId] = useState("");
  const [xocRamId, setXocRamId] = useState("");
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

  // Package from URL
  const selectedPackage = useMemo(() => {
    const queryPkg = {
      title: q.get("title") || "",
      price: q.get("price") || "",
      tag: q.get("tag") || "",
    };
    if (queryPkg.title) return queryPkg;
    if (persistedPackage) return persistedPackage;
    return queryPkg;
  }, [q, persistedPackage]);

  const prevPackageRef = useRef(selectedPackage.title);
  const prevPackageDataRef = useRef(selectedPackage);
  const [draftLoading, setDraftLoading] = useState(true);
  const [myHold, setMyHold] = useState(null);
  const [lockingSlot, setLockingSlot] = useState(false);
  const [holdCountdownMs, setHoldCountdownMs] = useState(null);
  const clearedNoHoldRef = useRef(false);
  const sessionRestoredRef = useRef(false);

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
            style={{ color: "#22D3EE" }}
            onClick={() => {
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
      const ref = q.get("ref") || "";
      if (ref) {
        sessionStorage.setItem(REFERRAL_STORAGE_KEY, ref);
      } else if (q.has("ref")) {
        sessionStorage.removeItem(REFERRAL_STORAGE_KEY);
      }
    } catch (err) {
      console.error("Failed to persist referral session:", err);
    }
  }, [q]);

  useEffect(() => {
    const prevTitle = prevPackageRef.current;
    const nextTitle = selectedPackage.title;
    if (prevTitle && prevTitle !== nextTitle) {
      const prevPkgData = prevPackageDataRef.current;
      if (
        prevPkgData &&
        !isDraftEmpty(form, xocMoboId, xocRamId, xocCustomMobo, xocCustomRam)
      ) {
        persistDraft({
          form: { ...form },
          selectedPackage: { ...prevPkgData },
          xocMoboId,
          xocRamId,
          xocCustomMobo,
          xocCustomRam,
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
    if (sessionRestoredRef.current) return;
    try {
      const raw = localStorage.getItem(SESSION_STATE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved.packageTitle === selectedPackage.title) {
          if (saved.step) setStep(saved.step);
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
    } catch (err) {
      console.error("Failed to restore session state:", err);
    } finally {
      sessionRestoredRef.current = true;
    }
  }, [selectedPackage.title]);

  // Persist modal session state
  useEffect(() => {
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
      localStorage.setItem(SESSION_STATE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.error("Failed to persist session state:", err);
    }
  }, [step, month, selectedDate, selectedSlot, selectedPackage.title]);

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
    setForm({
      discord: "",
      email: "",
      specs: "",
      mainGame: "",
      notes: "",
    });
    setXocMoboId("");
    setXocRamId("");
    setXocCustomMobo("");
    setXocCustomRam("");
    setSelectedSlot(null);
    setStep(1);
    clearedNoHoldRef.current = true;
    try {
      localStorage.removeItem(SESSION_STATE_KEY);
    } catch (err) {
      console.error("Failed to clear session state:", err);
    }
  }, [draftLoading, myHold, selectedPackage]);

  // Load existing hold from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(HOLD_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        // check if expired
        if (new Date(parsed.expiresAt) > new Date()) {
          const normalizedHold = {
            holdId: parsed.holdId,
            expiresAt: parsed.expiresAt,
            startTimeUTC: parsed.startTimeUTC,
            packageTitle: parsed.packageTitle,
            packagePrice: parsed.packagePrice,
            packageTag: parsed.packageTag,
          };
          const utcDate = getUtcDateFromHold(normalizedHold);
          if (!utcDate) {
            localStorage.removeItem(HOLD_STORAGE_KEY);
            return;
          }
          normalizedHold.startTimeUTC = utcDate.toISOString();
          localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(normalizedHold));
          setMyHold(normalizedHold);
          broadcastHold(normalizedHold);
        } else {
          localStorage.removeItem(HOLD_STORAGE_KEY);
        }
      }
    } catch (e) {
      console.error(e);
    }
  }, []);

  // Align UI with any active hold (including persisted)
  useEffect(() => {
    if (!myHold) return;

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
      const localDate = new Date(utcDate);
      localDate.setHours(0, 0, 0, 0);
      setSelectedDate(localDate);
    }

    if (samePackage && utcDate) {
      const slotId = utcDate.toISOString();
      setSelectedSlot((prev) =>
        prev?.slotId === slotId
          ? prev
          : {
              slotId,
              utcStart: utcDate,
              localLabel: formatLocalTime(utcDate, userTimeZone),
            }
      );
      setStep(2);
    } else {
      setSelectedSlot(null);
      setStep(1);
    }
  }, [myHold, selectedPackage.title, preventHoldAutoload, userTimeZone]);

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
        releaseHold();
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

  const clearErrorIfResolved = (
    nextForm = form,
    nextMobo = xocMoboId,
    nextRam = xocRamId,
    nextCustomMobo = xocCustomMobo,
    nextCustomRam = xocCustomRam
  ) => {
    if (!errorStep2) return;

    const baseFilled =
      nextForm.discord.trim() &&
      nextForm.email.trim() &&
      nextForm.specs.trim() &&
      nextForm.mainGame.trim();

    const xocFieldsOk =
      !isXoc ||
      (nextMobo &&
        nextRam &&
        (nextMobo !== "__CUSTOM_MOBO__" || nextCustomMobo.trim()) &&
        (nextRam !== "__CUSTOM_RAM__" || nextCustomRam.trim()));

    if (baseFilled && xocFieldsOk) {
      setErrorStep2("");
    }
  };

  // custom XOC fields
  const [xocCustomMobo, setXocCustomMobo] = useState("");
  const [xocCustomRam, setXocCustomRam] = useState("");

  const normalizedPackageTitle = normalizePackageKey(selectedPackage.title);

  // is this XOC?
  const isXoc =
    q.get("xoc") === "1" ||
    selectedPackage.title === "XOC / Extreme Overclocking" ||
    normalizedPackageTitle.includes("xoc");

  const isVertexEssentials =
    normalizedPackageTitle.includes("vertex essential");

  const displayPackage = modalPackage || vertexPackage;
  const isStep2Complete = useMemo(() => {
    const baseFilled =
      form.discord.trim() &&
      form.email.trim() &&
      form.specs.trim() &&
      form.mainGame.trim();

    const xocFilled = !isXoc
      ? true
      : xocMoboId &&
        xocRamId &&
        (xocMoboId !== "__CUSTOM_MOBO__" || xocCustomMobo.trim()) &&
        (xocRamId !== "__CUSTOM_RAM__" || xocCustomRam.trim());

    return Boolean(baseFilled && xocFilled);
  }, [
    form.discord,
    form.email,
    form.specs,
    form.mainGame,
    isXoc,
    xocMoboId,
    xocRamId,
    xocCustomMobo,
    xocCustomRam,
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

    if (isXoc) {
      if (!xocMoboId && !xocRamId) {
        return "Please select your motherboard and RAM kit for XOC.";
      }
      if (!xocMoboId) {
        return "Please select your motherboard for XOC.";
      }
      if (!xocRamId) {
        return "Please select your RAM kit for XOC.";
      }
      if (xocMoboId === "__CUSTOM_MOBO__" && !xocCustomMobo.trim()) {
        return "Please type your motherboard model for XOC.";
      }
      if (xocRamId === "__CUSTOM_RAM__" && !xocCustomRam.trim()) {
        return "Please type your RAM kit details for XOC.";
      }
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
    const packageTitleKey = normalizePackageKey(selectedPackage.title);
    const packageMap =
      packageTitleKey && packageMaps ? packageMaps[packageTitleKey] : null;
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
    const fetchData = async () => {
      try {
        const [sRaw, booked, holds] = await Promise.all([
          fetchWithRetry(
            `*[_type == "bookingSettings"][0]{
              ...,
              packageDateSlots[]{
                package->{_id,title},
                dateSlots
              }
            }`
          ),
          fetchWithRetry(
            `*[_type == "booking"]{startTimeUTC, packageTitle}`
          ),
          fetchWithRetry(
            `*[_type == "slotHold" && expiresAt > now()]{
              startTimeUTC,
              _id
            }`
          ),
        ]);

        if (!sRaw) throw new Error("Missing bookingSettings in Sanity.");

        const s = { ...sRaw };

        s.dateSlotMap = normalizeDateSlots(s.dateSlots);
        s.xocDateSlotMap = normalizeDateSlots(s.xocDateSlots);
        s.vertexEssentialsDateSlotMap = normalizeDateSlots(
          s.vertexEssentialsDateSlots
        );
        s.packageDateSlotMaps = normalizePackageDateSlots(s.packageDateSlots);

        const holdsMapped =
          (holds || [])
            .map((h) => ({
              startTimeUTC: h.startTimeUTC,
              isHold: true,
              holdId: h._id,
            }))
            .filter((h) => h.startTimeUTC) || [];

        const bookedMapped =
          booked
            ?.map((b) => ({
              startTimeUTC: b.startTimeUTC,
              isHold: false,
            }))
            .filter((b) => b.startTimeUTC) || [];

        s.bookedSlots = [...bookedMapped, ...holdsMapped];

        setSettings(s);
      } catch (err) {
        console.error("Error fetching booking data:", err);
      }
    };

    fetchData();
  }, []);

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
        const stored = localStorage.getItem(FORM_PREFILL_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          setForm((prev) => ({ ...prev, ...parsed }));
          localStorage.removeItem(FORM_PREFILL_KEY);
        }
      } catch (err) {
        console.error("Failed to prefill form from storage:", err);
      }
    }
  }, [location.search]);

  // Load persisted booking draft (keeps form + package when returning)
  // Load drafts (per-package)
  useEffect(() => {
    try {
      const storedDraft = localStorage.getItem(BOOKING_DRAFT_KEY);
      if (storedDraft) {
        const parsed = JSON.parse(storedDraft);
        setDrafts(parsed.packages || {});
        const key = getDraftKey(selectedPackage);
        const draftForPkg =
          (parsed.packages && parsed.packages[key]) ||
          (parsed.lastTitle && parsed.packages && parsed.packages[parsed.lastTitle]) ||
          null;
        if (draftForPkg) {
          if (draftForPkg.form) setForm((prev) => ({ ...prev, ...draftForPkg.form }));
          if (draftForPkg.selectedPackage) {
            setPersistedPackage(draftForPkg.selectedPackage);
          }
          if (draftForPkg.xocMoboId) setXocMoboId(draftForPkg.xocMoboId);
          if (draftForPkg.xocRamId) setXocRamId(draftForPkg.xocRamId);
          if (draftForPkg.xocCustomMobo) setXocCustomMobo(draftForPkg.xocCustomMobo);
          if (draftForPkg.xocCustomRam) setXocCustomRam(draftForPkg.xocCustomRam);
          setPreventHoldAutoload(false);
          setStep(2);
        }
      }
      setDraftLoading(false);
    } catch (err) {
      console.error("Failed to load booking draft:", err);
      setDraftLoading(false);
    }
  }, [selectedPackage.title]);

  const persistDraft = (payload) => {
    try {
      const current = localStorage.getItem(BOOKING_DRAFT_KEY);
      let parsed = { packages: {}, lastTitle: null };
      if (current) {
        parsed = { lastTitle: null, packages: {}, ...JSON.parse(current) };
      }
      const key = getDraftKey(payload.selectedPackage);
      parsed.packages[key] = payload;
      parsed.lastTitle = key;
      setDrafts(parsed.packages);
      localStorage.setItem(BOOKING_DRAFT_KEY, JSON.stringify(parsed));
    } catch (e) {
      console.error("Failed to persist booking draft:", e);
    }
  };

  const clearDraftForPackage = (pkgKey) => {
    try {
      const current = localStorage.getItem(BOOKING_DRAFT_KEY);
      if (!current) return;
      const parsed = { lastTitle: null, packages: {}, ...JSON.parse(current) };
      if (parsed.packages && parsed.packages[pkgKey]) {
        delete parsed.packages[pkgKey];
        if (parsed.lastTitle === pkgKey) parsed.lastTitle = null;
        setDrafts(parsed.packages);
        localStorage.setItem(BOOKING_DRAFT_KEY, JSON.stringify(parsed));
      }
    } catch (e) {
      console.error("Failed to clear draft:", e);
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
        const data = await client.fetch(
          `*[_type == "package" && title match "Performance Vertex Overhaul"][0]{
            title,
            price,
            tag,
            features,
            buttonText
          }`
        );
        setVertexPackage(data);
      } catch (err) {
        console.error("Error fetching Performance Vertex package:", err);
      }
    };
    fetchVertex();
  }, []);

  useEffect(() => {
    const fetchVertexEssentials = async () => {
      try {
        const data = await client.fetch(
          `*[_type == "package" && title match "Vertex Essentials"][0]{
            title,
            price,
            tag,
            features,
            buttonText
          }`
        );
        setVertexEssentialsPackage(data);
      } catch (err) {
        console.error("Error fetching Vertex Essentials package:", err);
      }
    };
    fetchVertexEssentials();
  }, []);

  // ---------- FETCH CURRENT PLAN PACKAGE (for view plan modal) ----------
  useEffect(() => {
    if (!selectedPackage.title) return;
    const fetchPlan = async () => {
      try {
        const data = await client.fetch(
          `*[_type == "package" && title == $title][0]{
            title,
            price,
            tag,
            features,
            buttonText
          }`,
          { title: selectedPackage.title }
        );
        setPlanPackage(data);
      } catch (err) {
        console.error("Error fetching current package:", err);
      }
    };
    fetchPlan();
  }, [selectedPackage.title]);

  // ---------- LOAD XOC PARTS FROM LOCAL OPENDB (API) ----------
  useEffect(() => {
    if (!isXoc) return;

    const loadXocParts = async () => {
      try {
        const res = await fetch("/api/xocParts");
        if (!res.ok) {
          console.error("Failed to load XOC parts:", res.status);
          return;
        }
        const data = await res.json();
        if (!data.ok) {
          console.error("XOC parts error:", data.error);
          return;
        }

        const sortedMobos = (data.motherboards || [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name));
        const sortedRams = (data.rams || [])
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name));

        setXocMotherboards(sortedMobos);
        setXocRams(sortedRams);
      } catch (err) {
        console.error("Error fetching /api/xocParts:", err);
      }
    };

    loadXocParts();
  }, [isXoc]);

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
    const { name, value } = e.target;
    const nextForm = { ...form, [name]: value };
    setForm(nextForm);
    clearErrorIfResolved(
      nextForm,
      xocMoboId,
      xocRamId,
      xocCustomMobo,
      xocCustomRam
    );
    const empty = isDraftEmpty(nextForm, xocMoboId, xocRamId, xocCustomMobo, xocCustomRam);
    if (empty) {
      clearDraftForPackage(getDraftKey(selectedPackage));
    } else {
      persistDraft({
        form: nextForm,
        selectedPackage: { ...selectedPackage },
        xocMoboId,
        xocRamId,
        xocCustomMobo,
        xocCustomRam,
      });
    }
  };

  useEffect(() => {
    if (draftLoading) return;
    const allEmpty =
      !form.discord.trim() &&
      !form.email.trim() &&
      !form.specs.trim() &&
      !form.mainGame.trim() &&
      !form.notes.trim() &&
      !xocMoboId &&
      !xocRamId &&
      !xocCustomMobo.trim() &&
      !xocCustomRam.trim();
    if (allEmpty) {
      clearDraftForPackage(getDraftKey(selectedPackage));
    }
  }, [
    form.discord,
    form.email,
    form.specs,
    form.mainGame,
    form.notes,
    xocMoboId,
    xocRamId,
    xocCustomMobo,
    xocCustomRam,
    selectedPackage,
    draftLoading,
  ]);

  const handleDayClick = (day) => {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    date.setHours(0, 0, 0, 0);

    if (!isDateAllowed(date)) return;

    setSelectedDate(date);
    setSelectedSlot(null);
    setPreventHoldAutoload(false);
    persistDraft({
      form,
      selectedPackage: { ...selectedPackage },
      xocMoboId,
      xocRamId,
      xocCustomMobo,
      xocCustomRam,
    });
  };

  const holdLocalTimeLabel = useMemo(() => {
    if (!myHold) return "";
    const utcDate = getUtcDateFromHold(myHold);
    if (!utcDate) return "";
    return formatLocalTime(utcDate, userTimeZone);
  }, [myHold, userTimeZone]);

  const clearHoldState = (resetStep = true, clearStorage = true) => {
    setMyHold(null);
    if (clearStorage) {
      localStorage.removeItem(HOLD_STORAGE_KEY);
    }
    setSelectedSlot(null);
    setHoldCountdownMs(null);
    if (resetStep) setStep(1);
    broadcastHold(null);
  };

  const updateHoldPackage = (pkg) => {
    if (!myHold) return;
    const updated = {
      ...myHold,
      packageTitle: pkg?.title || myHold.packageTitle,
      packagePrice: pkg?.price || myHold.packagePrice,
      packageTag: pkg?.tag || myHold.packageTag,
    };
    setMyHold(updated);
    try {
      localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(updated));
    } catch (e) {
      console.error("Failed to persist updated hold:", e);
    }
    broadcastHold(updated);
  };

  // ---------- RELEASE HOLD (Optimistic Update) ----------
  const releaseHold = async (resetStep = true) => {
    if (!myHold) return;

    const holdIdToDelete = myHold.holdId;

    clearHoldState(resetStep);

    try {
      await fetch("/api/releaseHold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdId: holdIdToDelete }),
      });
    } catch (err) {
      console.error("Failed to release hold on server:", err);
    }
  };

  // ---------- LOCK SLOT + GO TO STEP 2 ----------
  const handleLockAndGoNext = async () => {
    if (!selectedDate || !selectedSlot) {
      setErrorStep1("Please select a date and time before continuing.");
      return;
    }

    if (lockingSlot) return;

    setErrorStep1("");
    setLockingSlot(true);

    let previousHoldId = null;
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
      await releaseHold(false);
    }

    try {
      const body = {
        startTimeUTC: selectedSlotId,
        packageTitle: selectedPackage.title,
        previousHoldId,
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
        return;
      }

      const newHold = {
        holdId: data.holdId,
        expiresAt: data.expiresAt,
        startTimeUTC: selectedSlotId,
        packageTitle: selectedPackage.title,
        packagePrice: selectedPackage.price,
        packageTag: selectedPackage.tag,
      };

      setMyHold(newHold);
      localStorage.setItem(HOLD_STORAGE_KEY, JSON.stringify(newHold));
      broadcastHold(newHold);

      const expiresIn =
        newHold.expiresAt && new Date(newHold.expiresAt).getTime() - Date.now();
      if (Number.isFinite(expiresIn)) {
        setHoldCountdownMs(Math.max(0, expiresIn));
      }
      setStep(2);
    } catch (err) {
      console.error("Error reserving slot:", err);
      setErrorStep1(
        "Could not reserve this slot. Please check your internet and try again."
      );
    } finally {
      setLockingSlot(false);
    }
  };

  // ---------- SUBMIT ----------
  const handleSubmit = async () => {
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

    const referralFromQuery = q.get("ref") || "";
    const referralFromSession = readReferralFromSession();
    const finalReferralCode = referralFromQuery || referralFromSession;

    const isCustomMobo = isXoc && xocMoboId === "__CUSTOM_MOBO__";
    const isCustomRam = isXoc && xocRamId === "__CUSTOM_RAM__";

    const selectedMobo =
      isXoc && !isCustomMobo
        ? xocMotherboards.find((m) => m.id === xocMoboId)
        : null;
    const selectedRam =
      isXoc && !isCustomRam ? xocRams.find((r) => r.id === xocRamId) : null;

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
      slotHoldExpiresAt: myHold?.expiresAt || null,

      ...(finalReferralCode ? { referralCode: finalReferralCode } : {}),

      ...(isXoc && selectedMobo && selectedRam
        ? {
            xocMotherboardId: selectedMobo.id,
            xocMotherboardName: selectedMobo.name,
            xocMotherboardSocket: selectedMobo.socket,
            xocMotherboardRamType: selectedMobo.ram_type,
            xocRamId: selectedRam.id,
            xocRamName: selectedRam.name,
            xocRamSpeedMtps: selectedRam.speed,
            xocRamCl: selectedRam.cas_latency,
            xocRamCapacityGb: selectedRam.capacityGb,
          }
        : {}),

      ...(isXoc && isCustomMobo && xocCustomMobo.trim()
        ? {
            xocCustomMotherboard: xocCustomMobo.trim(),
          }
        : {}),
      ...(isXoc && isCustomRam && xocCustomRam.trim()
        ? {
            xocCustomRam: xocCustomRam.trim(),
          }
        : {}),
    };

    try {
      persistDraft({
        form: { ...form },
        selectedPackage: { ...selectedPackage },
        xocMoboId,
        xocRamId,
        xocCustomMobo,
        xocCustomRam,
      });
    } catch (e) {
      console.error("Failed to persist booking draft:", e);
    }

    // Keep hold persisted for banner
    const backgroundLocation =
      location.state?.backgroundLocation || location.state || null;
    navigate(`/payment?data=${encodeURIComponent(JSON.stringify(payload))}`, {
      state: backgroundLocation ? { backgroundLocation } : undefined,
    });
  };

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
        className={`text-white transition-opacity duration-300 ${
          pageFadeIn ? "opacity-100" : "opacity-0"
        }`}
      >
        {!settings ? (
          <div className="text-center text-sky-300 mt-20">Loading...</div>
        ) : (
          <>
            {selectedPackage.title && (
              <div className="mb-8 max-w-lg mx-auto bg-[#0b1120]/70 border border-sky-700/40 rounded-xl p-6 text-center shadow-[0_0_15px_rgba(14,165,233,0.25)]">
                {selectedPackage.tag && (
                  <div className="mb-2">
                    <span className="bg-sky-500/80 text-xs font-semibold px-3 py-1 rounded-full shadow-[0_0_8px_rgba(56,189,248,0.4)]">
                      {selectedPackage.tag}
                    </span>
                  </div>
                )}
                <h3 className="text-2xl font-bold text-sky-300">
                  {selectedPackage.title}
                </h3>
                <p className="text-3xl font-semibold text-sky-400 mt-2">
                  {selectedPackage.price}
                </p>
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
                  // NOTE: removed backdrop-blur-sm to fix text fuzziness
                  className="max-w-3xl mx-auto bg-[#0b1120]/90 border border-sky-700/30 rounded-2xl p-8 text-center shadow-[0_0_25px_rgba(14,165,233,0.15)]"
                >
                  <h3 className="text-sky-300 text-lg font-semibold mb-2">
                    Select a Date and Time for Your Session
                  </h3>
                  <p className="text-xs text-sky-400/70 mb-5">
                    Times are shown in{" "}
                    <span className="font-semibold">your local time</span> (
                    {userTimeZone}).
                  </p>

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
                          className="text-sky-400 hover:text-sky-300 transition"
                        >
                          ‹
                        </button>
                        <h4 className="text-xl font-semibold text-sky-200">
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
                          className="text-sky-400 hover:text-sky-300 transition"
                        >
                          ›
                        </button>
                      </div>

                      <div className="grid grid-cols-7 gap-2 text-sm text-sky-300 mb-2">
                        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                          (d) => (
                            <div key={d} className="font-semibold text-sky-400/70">
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
                              "bg-red-500 shadow-[0_0_6px_rgba(248,113,113,0.9)]";
                          } else if (slotInfo?.color === "yellow") {
                            dotClass =
                              "bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)]";
                          } else if (slotInfo?.color === "green") {
                            dotClass =
                              "bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]";
                          }

                          return (
                            <button
                              key={day}
                              disabled={disabled}
                              onClick={() => handleDayClick(day)}
                              className={`p-2 rounded-lg transition-all duration-200 flex flex-col items-center justify-center ${
                                isSelected
                                  ? "bg-sky-600 text-white shadow-[0_0_12px_rgba(56,189,248,0.6)]"
                                  : disabled
                                  ? "text-slate-500 cursor-not-allowed"
                                  : "hover:bg-sky-700/40 text-sky-200"
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
                      <div className="mt-3 flex flex-wrap justify-center gap-3 text-[10px] text-sky-300">
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
                          <span>Fully Available</span>
                        </div>
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.9)]" />
                          <span>Limited Slots</span>
                        </div>
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-red-500 shadow-[0_0_6px_rgba(248,113,113,0.9)]" />
                          <span>Fully Booked</span>
                        </div>
                        <div className="flex items-center gap-1 whitespace-nowrap">
                          <span className="h-2 w-2 rounded-full bg-purple-400 shadow-[0_0_6px_rgba(192,132,252,0.9)]" />
                          <span>Temporarily Reserved</span>
                        </div>
                      </div>
                    </div>

                    {selectedDate && (
                      <div className="flex-1">
                        <p className="text-sky-200 mb-3 font-semibold">
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
                                    ? "bg-slate-900/30 border-slate-700/30 text-slate-600 cursor-not-allowed"
                                    : t.isBooked
                                    ? "bg-red-900/40 border-red-700/40 text-red-400 cursor-not-allowed"
                                    : t.isHeldOther
                                    ? "bg-purple-900/40 border-purple-700/50 text-purple-300 cursor-not-allowed"
                                    : isMyHold
                                    ? "bg-purple-900/50 border-purple-500/60 text-purple-100 shadow-[0_0_14px_rgba(168,85,247,0.7)] hover:border-purple-400 hover:bg-purple-800/50"
                                    : t.disabled
                                    ? "bg-slate-800/40 text-slate-500 border-slate-700/50 cursor-not-allowed"
                                    : selectedSlot?.slotId === t.slotId
                                    ? "bg-sky-600 text-white border-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.6)]"
                                    : "border-sky-700/40 hover:border-sky-500/60 hover:bg-sky-700/20"
                                }`}
                              >
                                {t.localLabel}
                              </button>
                            );
                          })}
                        </div>
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
                    <p className="text-red-400 mt-3 text-sm">{errorStep1}</p>
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
                  // NOTE: removed backdrop-blur-sm
                  className="max-w-2xl mx-auto bg-[#0b1120]/90 border border-sky-700/30 rounded-2xl p-8 shadow-[0_0_25px_rgba(14,165,233,0.15)] space-y-6"
                >
                  {isXoc && (
                    <div className="space-y-4 border border-sky-700/50 rounded-xl p-4 bg-slate-900/40">
                      <h4 className="text-sky-300 font-semibold text-sm sm:text-base">
                        XOC Hardware Eligibility
                      </h4>
                      <p className="text-xs text-sky-400/80">
                        Choose your motherboard and RAM kit from the supported
                        list below.
                      </p>

                      <div
                        className={`grid gap-4 ${
                          isMobile ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"
                        }`}
                      >
                        <XocDropdown
                          label="Motherboard"
                          items={xocMotherboards}
                          value={xocMoboId}
                          onChange={(val) => {
                            setXocMoboId(val);
                            clearErrorIfResolved(
                              form,
                              val,
                              xocRamId,
                              xocCustomMobo,
                              xocCustomRam
                            );
                            const nextEmpty = isDraftEmpty(
                              form,
                              val,
                              xocRamId,
                              xocCustomMobo,
                              xocCustomRam
                            );
                            if (nextEmpty) {
                              clearDraftForPackage(getDraftKey(selectedPackage));
                            } else {
                              persistDraft({
                                form,
                                selectedPackage: { ...selectedPackage },
                                xocMoboId: val,
                                xocRamId,
                                xocCustomMobo,
                                xocCustomRam,
                              });
                            }
                          }}
                          placeholder={
                            xocMotherboards.length === 0
                              ? "No supported boards loaded"
                              : "Select Your Motherboard"
                          }
                          emptyMessage="No supported boards found"
                          getId={(m) => m.id}
                          getLabel={(m) => m.name}
                          customOptionId="__CUSTOM_MOBO__"
                          customOptionLabel="+ Add Your Own Motherboard"
                        />

                        <XocDropdown
                          label="RAM Kit"
                          items={xocRams}
                          value={xocRamId}
                          onChange={(val) => {
                            setXocRamId(val);
                            clearErrorIfResolved(
                              form,
                              xocMoboId,
                              val,
                              xocCustomMobo,
                              xocCustomRam
                            );
                            const nextEmpty = isDraftEmpty(
                              form,
                              xocMoboId,
                              val,
                              xocCustomMobo,
                              xocCustomRam
                            );
                            if (nextEmpty) {
                              clearDraftForPackage(getDraftKey(selectedPackage));
                            } else {
                              persistDraft({
                                form,
                                selectedPackage: { ...selectedPackage },
                                xocMoboId,
                                xocRamId: val,
                                xocCustomMobo,
                                xocCustomRam,
                              });
                            }
                          }}
                          placeholder={
                            xocRams.length === 0
                              ? "No eligible RAM kits loaded"
                              : "Select your RAM kit"
                          }
                          emptyMessage="No eligible RAM kits found"
                          getId={(r) => r.id}
                          getLabel={(r) =>
                            `${r.name} — ${r.speed} MT/s, CL${r.cas_latency}, ${r.capacityGb}GB`
                          }
                          customOptionId="__CUSTOM_RAM__"
                          customOptionLabel="+ Add your own RAM kit"
                        />

                        {xocMoboId === "__CUSTOM_MOBO__" && (
                          <div className={isMobile ? "" : "sm:col-span-2"}>
                            <input
                              type="text"
                              value={xocCustomMobo}
                              onChange={(e) => {
                                const next = e.target.value;
                                setXocCustomMobo(next);
                                clearErrorIfResolved(
                                  form,
                                  xocMoboId,
                                  xocRamId,
                                  next,
                                  xocCustomRam
                                );
                                const nextEmpty = isDraftEmpty(
                                  form,
                                  xocMoboId,
                                  xocRamId,
                                  next,
                                  xocCustomRam
                                );
                                if (nextEmpty) {
                                  clearDraftForPackage(
                                    getDraftKey(selectedPackage)
                                  );
                                } else {
                                  persistDraft({
                                    form,
                                    selectedPackage: { ...selectedPackage },
                                    xocMoboId,
                                    xocRamId,
                                    xocCustomMobo: next,
                                    xocCustomRam,
                                  });
                                }
                              }}
                              placeholder="Type your Motherboard Model (e.g. ASUS ROG STRIX X670E-E)"
                              className="w-full bg-[#020617] border border-sky-700/60 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-sky-400"
                            />
                          </div>
                        )}

                        {xocRamId === "__CUSTOM_RAM__" && (
                          <div className={isMobile ? "" : "sm:col-span-2"}>
                            <input
                              type="text"
                              value={xocCustomRam}
                              onChange={(e) => {
                                const next = e.target.value;
                                setXocCustomRam(next);
                                clearErrorIfResolved(
                                  form,
                                  xocMoboId,
                                  xocRamId,
                                  xocCustomMobo,
                                  next
                                );
                                const nextEmpty = isDraftEmpty(
                                  form,
                                  xocMoboId,
                                  xocRamId,
                                  xocCustomMobo,
                                  next
                                );
                                if (nextEmpty) {
                                  clearDraftForPackage(
                                    getDraftKey(selectedPackage)
                                  );
                                } else {
                                  persistDraft({
                                    form,
                                    selectedPackage: { ...selectedPackage },
                                    xocMoboId,
                                    xocRamId,
                                    xocCustomMobo,
                                    xocCustomRam: next,
                                  });
                                }
                              }}
                              placeholder="Type your RAM kit (e.g. 32GB 6000MT/s CL30, brand/model)"
                              className="w-full bg-[#020617] border border-sky-700/60 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-sky-400"
                            />
                          </div>
                        )}

                        {(xocMoboId === "__CUSTOM_MOBO__" ||
                          xocRamId === "__CUSTOM_RAM__") && (
                          <div className={isMobile ? "" : "sm:col-span-2"}>
                            <div className="mt-1 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2">
                              <p className="text-[11px] text-sky-100 leading-snug">
                                Custom motherboards and RAM kits may not fully
                                meet our XOC stability and compatibility criteria.
                                For the best results and safety, please reach out
                                on Discord so we can double-check your parts
                                before the session.
                              </p>
                            </div>
                          </div>
                        )}
                      </div>

                      <p className="text-[11px] text-sky-400/70 mt-2">
                        Only DDR5 AM5 boards and RAM kits that meet the XOC
                        requirements (6000 MT/s+ with CL limits) are shown in the
                        supported list.
                      </p>

                      {(xocMoboId === "__CUSTOM_MOBO__" ||
                        xocRamId === "__CUSTOM_RAM__") && (
                        <>
                          <div className="mt-2 flex flex-wrap justify-center gap-x-4 gap-y-2">
                            <button
                              type="button"
                              onClick={() => {
                                setModalMode("switch");
                                setModalPackage(vertexPackage);
                                setShowVertexModal(true);
                              }}
                              className="glow-button inline-flex items-center justify-center px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold text-white transition"
                            >
                              Switch to Performance Vertex Overhaul
                              <span className="glow-line glow-line-top" />
                              <span className="glow-line glow-line-right" />
                              <span className="glow-line glow-line-bottom" />
                              <span className="glow-line glow-line-left" />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setModalMode("switch");
                                setModalPackage(vertexEssentialsPackage);
                                setShowVertexModal(true);
                              }}
                              className="glow-button inline-flex items-center justify-center px-4 py-2 rounded-lg text-xs sm:text-sm font-semibold text-white transition"
                            >
                              Switch to Vertex Essentials
                              <span className="glow-line glow-line-top" />
                              <span className="glow-line glow-line-right" />
                              <span className="glow-line glow-line-bottom" />
                              <span className="glow-line glow-line-left" />
                            </button>
                          </div>
                          <p className="mt-2 text-[11px] font-bold bg-gradient-to-r from-sky-300 via-cyan-300 to-indigo-300 bg-clip-text text-transparent">
                            If your PC is found to be XOC eligible after booking
                            Performance Vertex Overhaul/Vertex Essentials, you may pay
                            the difference in price to upgrade.
                          </p>
                        </>
                      )}
                    </div>
                  )}

                  <input
                    name="discord"
                    placeholder="Discord (e.g. Servi#1234 or @Servi)"
                    onChange={handleChange}
                    value={form.discord}
                    className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 focus:outline-none focus:border-sky-500 transition"
                  />
                  <input
                    name="email"
                    type="email"
                    placeholder="Email"
                    onChange={handleChange}
                    value={form.email}
                    className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 focus:outline-none focus:border-sky-500 transition"
                  />
                  <input
                    name="specs"
                    placeholder={
                      isXoc ? "PC Specs (e.g. GPU, CPU, Cooling)" : "PC Specs"
                    }
                    onChange={handleChange}
                    value={form.specs}
                    className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 focus:outline-none focus:border-sky-500 transition"
                  />
                  <input
                    name="mainGame"
                    placeholder="Main use case (Game/Apps)"
                    onChange={handleChange}
                    value={form.mainGame}
                    className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 focus:outline-none focus:border-sky-500 transition"
                  />

                  <textarea
                    name="notes"
                    placeholder="Any extra requirements?"
                    onChange={handleChange}
                    value={form.notes}
                    className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 h-24 focus:outline-none focus:border-sky-500 transition"
                  ></textarea>

                  <p className="text-sky-400/60 text-xs">
                    Please read the FAQ before booking — it answers everything you
                    need to know.
                  </p>

                  {myHold &&
                    holdCountdownMs !== null &&
                    holdCountdownMs > 0 && (
                      <div className="bg-purple-500/10 border border-purple-500/40 p-3 rounded-lg flex items-center gap-3">
                        <p className="text-xs text-white font-medium">
                          Slot{" "}
                          <strong>{holdLocalTimeLabel || "--"}</strong>{" "}
                          is reserved.{" "}
                          <span className="text-sky-200">
                            Expires in {formatCountdown(holdCountdownMs)}.
                          </span>
                        </p>
                      </div>
                    )}

                  <div className="flex justify-between gap-4">
                    <button
                      onClick={() => {
                        releaseHold(true);
                        setStep(1);
                      }}
                      className="w-1/2 bg-slate-700/40 hover:bg-slate-700/60 py-3 rounded-lg font-semibold transition"
                    >
                      Back
                    </button>

                    <button
                      onClick={async () => {
                        if (loading) return;

                        const validationError = getStep2Error();
                        if (validationError) {
                          setErrorStep2(validationError);
                          return;
                        }

                        setErrorStep2("");
                        setLoading(true);
                        await handleSubmit();
                        setLoading(false);
                      }}
                      className={`glow-button w-1/2 py-3 rounded-lg font-semibold transition inline-flex items-center justify-center gap-2 ${
                        loading || !isStep2Complete
                          ? "opacity-60 cursor-not-allowed"
                          : ""
                      }`}
                    >
                      {loading ? "Submitting..." : "Submit & Pay"}
                      <span className="glow-line glow-line-top" />
                      <span className="glow-line glow-line-right" />
                      <span className="glow-line glow-line-bottom" />
                      <span className="glow-line glow-line-left" />
                    </button>

                    {errorStep2 && (
                      <p className="text-red-400 text-sm mt-3">{errorStep2}</p>
                    )}
                  </div>
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
                  className="relative w-full max-w-md bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 border border-sky-400/60 rounded-2xl shadow-[0_0_35px_rgba(56,189,248,0.4)] p-6 text-center transition-all duration-500 ease-in-out hover:shadow-[0_0_42px_rgba(56,189,248,0.5)]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <motion.button
                    aria-label="Close"
                    variants={itemVariants}
                    className="absolute right-3 top-3 text-sky-200 hover:text-white transition text-2xl z-10"
                    onClick={() => {
                      document.body.classList.remove("is-modal-blur");
                      setShowVertexModal(false);
                    }}
                  >
                    ×
                  </motion.button>

                  <motion.div variants={itemVariants}>
                    <div className="inline-flex items-center px-4 py-1.5 rounded-full text-xs font-semibold text-white bg-[#1fa7ff] shadow-[0_0_18px_rgba(31,167,255,0.6)] mb-4">
                      {displayPackage?.tag ||
                        "For All Budget, Mid-Ranged and High End PCs"}
                    </div>
                  </motion.div>

                  <motion.h3
                    variants={itemVariants}
                    className="text-2xl font-bold text-sky-100"
                  >
                    {displayPackage?.title || "Performance Vertex Overhaul"}
                  </motion.h3>

                  <motion.p
                    variants={itemVariants}
                    className="text-4xl font-bold text-sky-300 mt-2"
                  >
                    {displayPackage?.price || "$84.99"}
                  </motion.p>

                  <motion.ul className="mt-4 space-y-2 text-sm text-sky-100 text-left">
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
                        <span className="text-sky-400 mt-0.5">-</span>
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
                                "Performance Vertex Overhaul",
                              price: displayPackage?.price || "$84.99",
                              tag: displayPackage?.tag || "",
                            };
                            persistDraft({
                              form: { ...form },
                              selectedPackage: nextPackage,
                              xocMoboId,
                              xocRamId,
                              xocCustomMobo,
                              xocCustomRam,
                            });
                          } catch (err) {
                            console.error("Failed to store form draft:", err);
                          }
                          navigate(
                            `/booking?title=${encodeURIComponent(
                              displayPackage?.title ||
                                "Performance Vertex Overhaul"
                            )}&price=${encodeURIComponent(
                              displayPackage?.price || "$84.99"
                            )}&tag=${encodeURIComponent(
                              displayPackage?.tag || ""
                            )}&xoc=0`,
                            location.state?.backgroundLocation
                              ? {
                                  state: {
                                    backgroundLocation:
                                      location.state.backgroundLocation,
                                  },
                                }
                              : undefined
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
