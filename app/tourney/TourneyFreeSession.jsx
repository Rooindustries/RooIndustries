"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const IST_OFFSET_MINUTES = 330;
const FREE_SESSION_URL = "/api/tourney/free-session";
const DEFAULT_AVAILABILITY_URL = "/api/bookingAvailability";

// Mirrors the availability consumption in src/components/BookingForm.jsx:
// host slots are IST date + time values, converted to UTC slot ids.
const parseDateKey = (value) => {
  if (!value) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toDateString();
  }
  if (typeof value !== "string") return "";
  const datePart = value.split("T")[0];
  const [year, month, day] = datePart.split("-").map((num) => Number(num));
  if (!year || !month || !day) return "";
  const date = new Date(year, month - 1, day);
  if (Number.isNaN(date.getTime())) return "";
  return date.toDateString();
};

const parseTimeValue = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= 0 && value <= 23 ? { hour: value, minute: 0 } : null;
  }
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (
    !Number.isFinite(hour) || hour < 0 || hour > 23 ||
    !Number.isFinite(minute) || minute < 0 || minute > 59
  ) {
    return null;
  }
  return { hour, minute };
};

const normalizeDateSlots = (slots) => {
  const map = {};
  (slots || []).forEach((slot) => {
    const dateKey = parseDateKey(slot?.date);
    if (!dateKey) return;
    const timesRaw = Array.isArray(slot?.times) ? slot.times : [];
    const times = timesRaw
      .map(parseTimeValue)
      .filter(Boolean)
      .map((time) => time.hour * 60 + time.minute);
    const unique = Array.from(new Set(times)).sort((a, b) => a - b);
    if (!unique.length) return;
    map[dateKey] = unique;
  });
  return map;
};

const normalizePackageKey = (value) =>
  String(value || "").toLowerCase().replace(/\s+/g, " ").trim();

const pickDateSlotMap = (settings, packageTitle) => {
  if (!settings) return null;
  const titleKey = normalizePackageKey(packageTitle);
  const packageEntries = Array.isArray(settings.packageDateSlots)
    ? settings.packageDateSlots
    : [];
  const packageMap = packageEntries
    .filter(
      (entry) => normalizePackageKey(entry?.package?.title) === titleKey
    )
    .map((entry) => normalizeDateSlots(entry?.dateSlots))
    .find((map) => map && Object.keys(map).length > 0);
  if (packageMap) return packageMap;

  const baseMap = normalizeDateSlots(settings.dateSlots);
  if (Object.keys(baseMap).length > 0) return baseMap;
  const essentialsMap = normalizeDateSlots(settings.vertexEssentialsDateSlots);
  if (Object.keys(essentialsMap).length > 0) return essentialsMap;
  const xocMap = normalizeDateSlots(settings.xocDateSlots);
  if (Object.keys(xocMap).length > 0) return xocMap;
  return null;
};

const getUtcFromHostLocal = (year, monthIndex, day, minutesOfDay) => {
  const hour = Math.floor(minutesOfDay / 60);
  const minute = minutesOfDay % 60;
  const utcMs =
    Date.UTC(year, monthIndex, day, hour, minute) -
    IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs);
};

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

const createIdempotencyKey = () => {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `tourney-free-${random}`.slice(0, 128);
};

const buildLocalSlotMap = (settings, packageTitle, userTimeZone) => {
  const dateSlotMap = pickDateSlotMap(settings, packageTitle);
  if (!dateSlotMap) return null;

  const bookedSet = new Set();
  const heldSet = new Set();
  (settings.bookedSlots || []).forEach((slot) => {
    if (!slot?.startTimeUTC) return;
    if (slot.isHold) {
      if (!slot.isExpiredHold) heldSet.add(slot.startTimeUTC);
      return;
    }
    bookedSet.add(slot.startTimeUTC);
  });

  const now = new Date();
  const map = {};
  Object.entries(dateSlotMap).forEach(([hostDateKey, minutesList]) => {
    const hostDate = new Date(hostDateKey);
    if (Number.isNaN(hostDate.getTime())) return;

    (minutesList || []).forEach((minutesOfDay) => {
      if (!Number.isFinite(minutesOfDay)) return;
      const utcStart = getUtcFromHostLocal(
        hostDate.getFullYear(),
        hostDate.getMonth(),
        hostDate.getDate(),
        minutesOfDay
      );
      if (Number.isNaN(utcStart.getTime())) return;

      const slotId = utcStart.toISOString();
      if (utcStart <= now || bookedSet.has(slotId) || heldSet.has(slotId)) {
        return;
      }

      const localDateKey = getLocalDateKey(utcStart, userTimeZone);
      if (!localDateKey) return;
      const list = map[localDateKey] || [];
      list.push({
        slotId,
        utcStart,
        localLabel: formatLocalTime(utcStart, userTimeZone),
      });
      map[localDateKey] = list;
    });
  });

  Object.values(map).forEach((list) =>
    list.sort((left, right) => left.utcStart - right.utcStart)
  );
  return map;
};

export default function TourneyFreeSession() {
  const [phase, setPhase] = useState("loading");
  const [packageTitle, setPackageTitle] = useState("Tourney Free Optimization");
  const [availabilityUrl, setAvailabilityUrl] = useState(DEFAULT_AVAILABILITY_URL);
  const [booking, setBooking] = useState(null);
  const [settings, setSettings] = useState(null);
  const [availabilityError, setAvailabilityError] = useState("");
  const [selectedDateKey, setSelectedDateKey] = useState("");
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [form, setForm] = useState({
    email: "",
    discord: "",
    specs: "",
    mainGame: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const idempotencyKeyRef = useRef("");

  const userTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const applyState = useCallback((data) => {
    const entitlement = data?.entitlement || null;
    if (
      !entitlement ||
      !["available", "consumed"].includes(entitlement.status)
    ) {
      setPhase("hidden");
      return;
    }
    setPackageTitle(data.packageTitle || "Tourney Free Optimization");
    setAvailabilityUrl(data.availabilityUrl || DEFAULT_AVAILABILITY_URL);
    if (entitlement.status === "consumed") {
      setBooking(entitlement.booking || null);
      setPhase("consumed");
      return;
    }
    setPhase("available");
  }, []);

  useEffect(() => {
    let active = true;
    const loadState = async () => {
      try {
        const response = await fetch(FREE_SESSION_URL, { cache: "no-store" });
        const data = await response.json().catch(() => null);
        if (!active) return;
        if (!response.ok || !data?.ok) {
          setPhase("hidden");
          return;
        }
        applyState(data);
      } catch {
        if (active) setPhase("hidden");
      }
    };
    loadState();
    return () => {
      active = false;
    };
  }, [applyState]);

  const loadAvailability = useCallback(async () => {
    setAvailabilityError("");
    try {
      const response = await fetch(availabilityUrl, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.settings) {
        throw new Error("Missing booking availability settings.");
      }
      setSettings({
        ...data.settings,
        bookedSlots: Array.isArray(data.bookedSlots) ? data.bookedSlots : [],
      });
    } catch {
      setSettings(null);
      setAvailabilityError("Booking availability took too long to load.");
    }
  }, [availabilityUrl]);

  useEffect(() => {
    if (phase === "available") loadAvailability();
  }, [phase, loadAvailability]);

  const localSlotMap = useMemo(
    () => buildLocalSlotMap(settings, packageTitle, userTimeZone),
    [settings, packageTitle, userTimeZone]
  );

  const dateOptions = useMemo(() => {
    if (!localSlotMap) return [];
    return Object.keys(localSlotMap)
      .map((dateKey) => {
        const slots = localSlotMap[dateKey] || [];
        if (!slots.length) return null;
        return {
          dateKey,
          label: formatShortLocalDate(slots[0].utcStart, userTimeZone),
          slots,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.slots[0].utcStart - right.slots[0].utcStart);
  }, [localSlotMap, userTimeZone]);

  const activeDate =
    dateOptions.find((option) => option.dateKey === selectedDateKey) ||
    dateOptions[0] ||
    null;

  const selectSlot = (slot) => {
    idempotencyKeyRef.current = "";
    setSelectedSlot(slot);
    setError("");
  };

  const updateForm = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }));
  };

  const handleBook = async (event) => {
    event.preventDefault();
    if (busy) return;

    if (!selectedSlot) {
      setError("Choose an available session time.");
      return;
    }
    if (!form.email.trim() || !form.discord.trim()) {
      setError("Enter your email and Discord so we can confirm the session.");
      return;
    }

    if (!idempotencyKeyRef.current) {
      idempotencyKeyRef.current = createIdempotencyKey();
    }

    setBusy(true);
    setError("");
    try {
      const response = await fetch(FREE_SESSION_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKeyRef.current,
        },
        body: JSON.stringify({
          action: "book",
          startTimeUTC: selectedSlot.slotId,
          email: form.email.trim(),
          discord: form.discord.trim(),
          specs: form.specs.trim(),
          mainGame: form.mainGame.trim(),
          timezone: userTimeZone,
        }),
      });
      const data = await response.json().catch(() => null);

      if (response.ok && data?.ok) {
        idempotencyKeyRef.current = "";
        applyState(data);
        return;
      }

      const message =
        data?.error || "Unable to book the free session. Please try again.";
      setError(message);
      if (data?.code === "TOURNEY_FREE_SESSION_SLOT_CONFLICT") {
        idempotencyKeyRef.current = "";
        setSelectedSlot(null);
        loadAvailability();
      }
    } catch {
      setError("Unable to book the free session. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "loading" || phase === "hidden") return null;

  return (
    <section
      aria-labelledby="tourney-free-session-title"
      className="tourney-section tourney-section-wide tourney-free-session"
      id="free-session"
    >
      <p className="tourney-eyebrow">Player Perk</p>
      <h2 id="tourney-free-session-title">Free PC Optimization Session</h2>
      <div className="tourney-section-body">
        {phase === "consumed" ? (
          <div className="tourney-date-callout">
            <strong>Your free session is booked</strong>
            {booking?.startTimeUTC ? (
              <span>
                {formatLocalDate(new Date(booking.startTimeUTC), userTimeZone)}
                {" at "}
                {formatLocalTime(new Date(booking.startTimeUTC), userTimeZone)}
                {" ("}
                {userTimeZone}
                {")"}
              </span>
            ) : (
              <span>Your booking is confirmed.</span>
            )}
            <span>
              Booking status: {booking?.status || "confirmed"}
            </span>
          </div>
        ) : (
          <form className="tourney-form" onSubmit={handleBook}>
            <p className="tourney-form-note">
              Approved players get one free optimization session. Pick a time
              below — all times are shown in your timezone ({userTimeZone}).
            </p>

            {availabilityError ? (
              <p className="tourney-form-message" role="alert">
                {availabilityError}{" "}
                <button
                  className="tourney-owner-link"
                  onClick={loadAvailability}
                  type="button"
                >
                  Retry
                </button>
              </p>
            ) : null}

            {!availabilityError && settings ? (
              <div className="tourney-slot-picker">
                <p className="tourney-slot-label">Date</p>
                {dateOptions.length ? (
                  <>
                    <div className="tourney-slot-dates">
                      {dateOptions.map((option) => (
                        <button
                          aria-pressed={
                            activeDate?.dateKey === option.dateKey
                          }
                          className={
                            activeDate?.dateKey === option.dateKey
                              ? "tourney-slot-date is-active"
                              : "tourney-slot-date"
                          }
                          key={option.dateKey}
                          onClick={() => setSelectedDateKey(option.dateKey)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <p className="tourney-slot-label">Time</p>
                    <div className="tourney-slot-times">
                      {(activeDate?.slots || []).map((slot) => (
                        <button
                          aria-pressed={
                            selectedSlot?.slotId === slot.slotId
                          }
                          className={
                            selectedSlot?.slotId === slot.slotId
                              ? "tourney-slot-time is-selected"
                              : "tourney-slot-time"
                          }
                          key={slot.slotId}
                          onClick={() => selectSlot(slot)}
                          type="button"
                        >
                          {slot.localLabel}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="tourney-slot-empty">
                    No open session times right now. Check back soon.
                  </p>
                )}
              </div>
            ) : null}

            <div className="tourney-form-grid">
              <label>
                Email
                <input
                  autoComplete="email"
                  onChange={updateForm("email")}
                  placeholder="Email for the booking confirmation"
                  required
                  type="email"
                  value={form.email}
                />
              </label>
              <label>
                Discord
                <input
                  autoComplete="off"
                  onChange={updateForm("discord")}
                  placeholder="Discord username"
                  required
                  type="text"
                  value={form.discord}
                />
              </label>
            </div>
            <label>
              PC specs (optional)
              <textarea
                onChange={updateForm("specs")}
                placeholder="CPU, GPU, RAM, motherboard, cooling"
                value={form.specs}
              />
            </label>
            <label>
              Main game (optional)
              <input
                autoComplete="off"
                onChange={updateForm("mainGame")}
                placeholder="The game you want tuned first"
                type="text"
                value={form.mainGame}
              />
            </label>

            {error ? (
              <p className="tourney-form-message" role="alert">
                {error}
              </p>
            ) : null}

            <button
              className="tourney-owner-button"
              disabled={busy || !settings || !!availabilityError}
              type="submit"
            >
              {busy ? "Booking..." : "Book free session"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
