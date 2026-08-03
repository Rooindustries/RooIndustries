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

// Mirrors the calendar availability states in src/components/BookingForm.jsx.
const CALENDAR_AVAILABILITY_LABELS = Object.freeze({
  green: "open",
  yellow: "a few left",
  red: "booked out",
});

const formatCalendarDateLabel = (date) => {
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "long",
      day: "numeric",
      year: "numeric",
    }).format(date);
  } catch {
    return date.toDateString();
  }
};

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const buildSlotData = (settings, packageTitle, userTimeZone) => {
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
  const bookable = {};
  const dayStatus = {};
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

      const localDateKey = getLocalDateKey(utcStart, userTimeZone);
      if (!localDateKey) return;

      const slotId = utcStart.toISOString();
      const isUnavailable =
        utcStart <= now || bookedSet.has(slotId) || heldSet.has(slotId);

      const status = dayStatus[localDateKey] || { total: 0, available: 0 };
      status.total += 1;
      if (!isUnavailable) {
        status.available += 1;
        const list = bookable[localDateKey] || [];
        list.push({
          slotId,
          utcStart,
          localLabel: formatLocalTime(utcStart, userTimeZone),
        });
        bookable[localDateKey] = list;
      }
      dayStatus[localDateKey] = status;
    });
  });

  Object.values(bookable).forEach((list) =>
    list.sort((left, right) => left.utcStart - right.utcStart)
  );
  return { bookable, dayStatus };
};

export default function TourneyFreeSession() {
  const [phase, setPhase] = useState("loading");
  const [packageTitle, setPackageTitle] = useState("Tourney Free Optimization");
  const [availabilityUrl, setAvailabilityUrl] = useState(DEFAULT_AVAILABILITY_URL);
  const [booking, setBooking] = useState(null);
  const [settings, setSettings] = useState(null);
  const [availabilityError, setAvailabilityError] = useState("");
  const [selectedDate, setSelectedDate] = useState(null);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
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
  const mountedRef = useRef(true);
  const availabilityFetchRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  const loadState = useCallback(async () => {
    try {
      const response = await fetch(FREE_SESSION_URL, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!mountedRef.current) return;
      if (!response.ok || !data?.ok) {
        setPhase("hidden");
        return;
      }
      applyState(data);
    } catch {
      if (mountedRef.current) setPhase("hidden");
    }
  }, [applyState]);

  useEffect(() => {
    loadState();
  }, [loadState]);

  const loadAvailability = useCallback(async () => {
    const fetchId = availabilityFetchRef.current + 1;
    availabilityFetchRef.current = fetchId;
    setAvailabilityError("");
    try {
      const response = await fetch(availabilityUrl, { cache: "no-store" });
      const data = await response.json().catch(() => null);
      if (!mountedRef.current || availabilityFetchRef.current !== fetchId) {
        return;
      }
      if (!response.ok || !data?.settings) {
        throw new Error("Missing booking availability settings.");
      }
      setSettings({
        ...data.settings,
        bookedSlots: Array.isArray(data.bookedSlots) ? data.bookedSlots : [],
      });
    } catch {
      if (!mountedRef.current || availabilityFetchRef.current !== fetchId) {
        return;
      }
      setSettings(null);
      setAvailabilityError("The schedule took too long to load.");
    }
  }, [availabilityUrl]);

  useEffect(() => {
    if (phase === "available") loadAvailability();
  }, [phase, loadAvailability]);

  const slotData = useMemo(
    () => buildSlotData(settings, packageTitle, userTimeZone),
    [settings, packageTitle, userTimeZone]
  );

  const startOfToday = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
  }, []);

  const earliestSlot = useMemo(() => {
    if (!slotData) return null;
    const all = Object.values(slotData.bookable)
      .flat()
      .sort((left, right) => left.utcStart - right.utcStart);
    return all[0] || null;
  }, [slotData]);

  const hasBookableSlots = !!earliestSlot;

  const getDayColor = (dateObj) => {
    if (!slotData) return null;
    const status = slotData.dayStatus[dateObj.toDateString()];
    if (!status || !status.total) return null;
    if (status.available === 0) return "red";
    if (status.available <= 5) return "yellow";
    return "green";
  };

  const isDateAllowed = (dateObj) => {
    if (!slotData) return false;
    const d = new Date(dateObj);
    d.setHours(0, 0, 0, 0);
    if (d < startOfToday) return false;
    const slots = slotData.bookable[d.toDateString()];
    return Array.isArray(slots) && slots.length > 0;
  };

  // Mirror BookingForm: auto-select the earliest day that has open slots.
  useEffect(() => {
    if (!slotData || selectedDate) return;
    const nextDate = Object.keys(slotData.bookable)
      .map((key) => new Date(key))
      .filter((d) => !Number.isNaN(d.getTime()) && d >= startOfToday)
      .sort((a, b) => a - b)[0];
    if (!nextDate) return;
    const initialDate = new Date(nextDate);
    initialDate.setHours(0, 0, 0, 0);
    setSelectedDate(initialDate);
    setMonth(new Date(initialDate.getFullYear(), initialDate.getMonth(), 1));
  }, [slotData, selectedDate, startOfToday]);

  const selectedDaySlots =
    selectedDate && slotData
      ? slotData.bookable[selectedDate.toDateString()] || []
      : [];

  const handleDayClick = (day) => {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    date.setHours(0, 0, 0, 0);
    if (!isDateAllowed(date)) return;
    setSelectedDate(date);
    setSelectedSlot(null);
  };

  const handleEarliestClick = () => {
    if (!earliestSlot) return;
    const dateKey = getLocalDateKey(earliestSlot.utcStart, userTimeZone);
    const date = dateKey ? new Date(dateKey) : null;
    if (!date || Number.isNaN(date.getTime())) return;
    date.setHours(0, 0, 0, 0);
    setMonth(new Date(date.getFullYear(), date.getMonth(), 1));
    setSelectedDate(date);
    selectSlot(earliestSlot);
  };

  const shiftMonth = (offset) => {
    setMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + offset, 1));
  };

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
      setError("Choose an open time first.");
      return;
    }
    if (!form.email.trim() || !form.discord.trim()) {
      setError("I need your email and Discord to confirm the booking.");
      return;
    }
    if (!form.specs.trim()) {
      setError("Tell me your PC specs so I can prep for the session.");
      return;
    }
    if (!form.mainGame.trim()) {
      setError("Tell me your main game so I know what to tune for.");
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

      // The server definitively rejected this attempt; the key must not be
      // replayed against an edited payload or it 409s on the key itself.
      idempotencyKeyRef.current = "";
      const message =
        data?.error || "Couldn't book the session. Try again.";
      setError(message);
      if (data?.code === "TOURNEY_FREE_SESSION_SLOT_CONFLICT") {
        setSelectedSlot(null);
        loadAvailability();
      } else if (data?.code === "TOURNEY_FREE_SESSION_ALREADY_BOOKED") {
        await loadState();
      }
    } catch {
      setError("Couldn't book the session. Try again.");
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
              Approved players get one free optimization session. Pick a day,
              then a time.
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
                {hasBookableSlots ? (
                  <>
                    <button
                      className="tourney-cal-earliest"
                      onClick={handleEarliestClick}
                      type="button"
                    >
                      First open slot:{" "}
                      {formatShortLocalDate(earliestSlot.utcStart, userTimeZone)}
                      {" at "}
                      {earliestSlot.localLabel}
                    </button>

                    <div className="tourney-cal">
                      <div className="tourney-cal-month">
                        <div className="tourney-cal-head">
                          <button
                            aria-label="Previous month"
                            className="tourney-cal-nav"
                            onClick={() => shiftMonth(-1)}
                            type="button"
                          >
                            ‹
                          </button>
                          <p className="tourney-cal-title">
                            {month.toLocaleString("default", {
                              month: "long",
                            })}{" "}
                            {month.getFullYear()}
                          </p>
                          <button
                            aria-label="Next month"
                            className="tourney-cal-nav"
                            onClick={() => shiftMonth(1)}
                            type="button"
                          >
                            ›
                          </button>
                        </div>

                        <div className="tourney-cal-weekdays">
                          {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(
                            (dayName) => (
                              <span key={dayName}>{dayName}</span>
                            )
                          )}
                        </div>

                        <div className="tourney-cal-days">
                          {Array(
                            new Date(
                              month.getFullYear(),
                              month.getMonth(),
                              1
                            ).getDay()
                          )
                            .fill(null)
                            .map((_, index) => (
                              <span key={`empty-${index}`} />
                            ))}
                          {Array.from(
                            {
                              length: new Date(
                                month.getFullYear(),
                                month.getMonth() + 1,
                                0
                              ).getDate(),
                            },
                            (_, index) => index + 1
                          ).map((day) => {
                            const date = new Date(
                              month.getFullYear(),
                              month.getMonth(),
                              day
                            );
                            date.setHours(0, 0, 0, 0);
                            const disabled = !isDateAllowed(date);
                            const isSelected =
                              selectedDate && isSameDay(date, selectedDate);
                            const color = getDayColor(date);
                            const availabilityLabel = color
                              ? CALENDAR_AVAILABILITY_LABELS[color]
                              : "";
                            const dateLabel = formatCalendarDateLabel(date);
                            return (
                              <button
                                aria-label={
                                  availabilityLabel
                                    ? `${dateLabel}, ${availabilityLabel}`
                                    : dateLabel
                                }
                                aria-pressed={isSelected ? true : undefined}
                                className={
                                  isSelected
                                    ? "tourney-cal-day is-selected"
                                    : "tourney-cal-day"
                                }
                                disabled={disabled}
                                key={day}
                                onClick={() => handleDayClick(day)}
                                type="button"
                              >
                                <span>{day}</span>
                                {color ? (
                                  <span
                                    aria-hidden="true"
                                    className={`tourney-cal-dot is-${color}`}
                                  />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>

                        <div className="tourney-cal-legend">
                          <span className="tourney-cal-legend-item">
                            <span
                              aria-hidden="true"
                              className="tourney-cal-dot is-green"
                            />
                            Open
                          </span>
                          <span className="tourney-cal-legend-item">
                            <span
                              aria-hidden="true"
                              className="tourney-cal-dot is-yellow"
                            />
                            Few left
                          </span>
                          <span className="tourney-cal-legend-item">
                            <span
                              aria-hidden="true"
                              className="tourney-cal-dot is-red"
                            />
                            Booked out
                          </span>
                          <span className="tourney-cal-legend-item">
                            <span
                              aria-hidden="true"
                              className="tourney-cal-dot is-held"
                            />
                            On hold
                          </span>
                        </div>
                        <p className="tourney-cal-tz">
                          All times are in your timezone (
                          {userTimeZone.replace(/_/g, " ")})
                        </p>
                      </div>

                      {selectedDate ? (
                        <div className="tourney-cal-times">
                          <p className="tourney-slot-label">
                            Open times for{" "}
                            {selectedDate.toLocaleDateString(undefined, {
                              weekday: "long",
                              month: "long",
                              day: "numeric",
                            })}
                          </p>
                          {selectedDaySlots.length ? (
                            <div className="tourney-slot-times">
                              {selectedDaySlots.map((slot) => (
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
                          ) : (
                            <p className="tourney-slot-empty">
                              No open times left on this date.
                            </p>
                          )}
                        </div>
                      ) : null}
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
                  placeholder="Email for the confirmation"
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
              PC specs
              <textarea
                onChange={updateForm("specs")}
                placeholder="CPU, GPU, RAM, motherboard, cooling"
                required
                value={form.specs}
              />
            </label>
            <label>
              Main game
              <input
                autoComplete="off"
                onChange={updateForm("mainGame")}
                placeholder="The game you play most"
                required
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
              {busy ? "Booking..." : "Book my session"}
            </button>
          </form>
        )}
      </div>
    </section>
  );
}
