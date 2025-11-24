import React, { useEffect, useMemo, useState } from "react";
import { client } from "../sanityClient";
import { useLocation, useNavigate } from "react-router-dom";

// ---------- CONSTANTS ----------
const HOST_TZ_NAME = "Asia/Kolkata";
const IST_OFFSET_MINUTES = 330;

// Read query params
function useQuery() {
  const { search } = useLocation();
  return new URLSearchParams(search);
}

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const hostTimeLabel = (h) => {
  const ampm = h >= 12 ? "PM" : "AM";
  const disp = ((h + 11) % 12) + 1;
  return `${disp}:00 ${ampm}`;
};

const getUtcFromHostLocal = (year, monthIndex, day, hostHour) => {
  const utcMs =
    Date.UTC(year, monthIndex, day, hostHour, 0) -
    IST_OFFSET_MINUTES * 60 * 1000;
  return new Date(utcMs);
};

// Format a UTC Date into the user's local time string
const formatLocalTime = (utcDate) => {
  try {
    return utcDate.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return utcDate.toISOString();
  }
};

export default function BookingForm() {
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

  const [userTimeZone, setUserTimeZone] = useState("UTC");

  const [form, setForm] = useState({
    discord: "",
    email: "",
    specs: "",
    mainGame: "",
    notes: "",
  });

  // Package from URL
  const selectedPackage = useMemo(
    () => ({
      title: q.get("title") || "",
      price: q.get("price") || "",
      tag: q.get("tag") || "",
    }),
    [q]
  );

  // is this XOC?
  const isXoc =
    q.get("xoc") === "1" ||
    selectedPackage.title === "XOC / Extreme Overclocking";

  // ---------- DETECT USER TIME ZONE ----------
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      setUserTimeZone(tz);
    } catch {
      setUserTimeZone("UTC");
    }
  }, []);

  const startOfToday = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);

  // ---------- FETCH SETTINGS ----------
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [sRaw, booked] = await Promise.all([
          client.fetch(`*[_type == "bookingSettings"][0]`),
          client.fetch(
            `*[_type == "booking"]{date, time, startTimeUTC, packageTitle}`
          ),
        ]);

        if (!sRaw) throw new Error("Missing bookingSettings in Sanity.");

        const s = { ...sRaw };

        s.openHour = Number(s.openHour ?? 9);
        s.closeHour = Number(s.closeHour ?? 21);

        if (s.xocOpenHour !== undefined && s.xocOpenHour !== null) {
          s.xocOpenHour = Number(s.xocOpenHour);
        }
        if (s.xocCloseHour !== undefined && s.xocCloseHour !== null) {
          s.xocCloseHour = Number(s.xocCloseHour);
        }

        s.bookedSlots = booked || [];
        setSettings(s);
      } catch (err) {
        console.error("Error fetching booking data:", err);
      }
    };

    fetchData();
  }, []);

  const times = useMemo(() => {
    if (!settings || !selectedDate) return [];

    const hostYear = selectedDate.getFullYear();
    const hostMonth = selectedDate.getMonth();
    const hostDay = selectedDate.getDate();

    const dayName = selectedDate
      .toLocaleDateString("en-US", { weekday: "long" })
      .toLowerCase();

    // choose correct weekly slots
    const weeklyObj = isXoc
      ? settings.xocAvailableTimes || {}
      : settings.availableTimes || {};

    const allowedRaw = weeklyObj[dayName] || [];
    const allowed = allowedRaw.map((x) => Number(x));

    // choose open/close hours
    const open = isXoc
      ? settings.xocOpenHour ?? settings.openHour ?? 0
      : settings.openHour ?? 0;

    const close = isXoc
      ? settings.xocCloseHour ?? settings.closeHour ?? 23
      : settings.closeHour ?? 23;

    const hostDateLabel = selectedDate.toDateString();
    const bookedForDayHost =
      settings.bookedSlots
        ?.filter((b) => b.date === hostDateLabel)
        .map((b) => b.time) || [];

    const slots = [];
    for (let h = open; h <= close; h++) {
      const hostLabel = hostTimeLabel(h);
      const isAllowed = allowed.includes(h);
      const isBooked = bookedForDayHost.includes(hostLabel);
      const disabled = !isAllowed || isBooked;

      const utcStart = getUtcFromHostLocal(hostYear, hostMonth, hostDay, h);
      const localLabel = formatLocalTime(utcStart);

      slots.push({
        hostHour: h,
        hostLabel,
        localLabel,
        utcStart,
        disabled,
        isBooked,
        isAllowed,
      });
    }

    return slots;
  }, [settings, selectedDate, isXoc]);

  // ---------- INITIAL DATE ----------
  useEffect(() => {
    if (settings && !selectedDate) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      setSelectedDate(today);
      setMonth(today);
    }
  }, [settings, selectedDate]);

  // ---------- HELPERS ----------
  const handleChange = (e) =>
    setForm((prev) => ({ ...prev, [e.target.name]: e.target.value }));

  const handleDayClick = (day) => {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    date.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + (settings.maxDaysAheadBooking || 7));
    maxDate.setHours(0, 0, 0, 0);

    if (date < today || date > maxDate) return;

    setSelectedDate(date);
    setSelectedSlot(null);
  };

  // ---------- SUBMIT ----------
  const handleSubmit = async () => {
    if (!selectedDate || !selectedSlot) return;

    const displayDate = selectedDate.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    const displayTime = selectedSlot.localLabel;

    const payload = {
      displayDate,
      displayTime,

      hostDate: selectedDate.toDateString(),
      hostTime: selectedSlot.hostLabel,
      hostTimeZone: HOST_TZ_NAME,

      localTimeZone: userTimeZone,
      localTimeLabel: selectedSlot.localLabel,

      startTimeUTC: selectedSlot.utcStart.toISOString(),

      discord: form.discord.trim(),
      email: form.email.trim(),
      specs: form.specs.trim(),
      mainGame: form.mainGame.trim(),
      message: form.notes.trim(),

      packageTitle: selectedPackage.title,
      packagePrice: selectedPackage.price,

      status: "pending",
    };

    if (isXoc) {
      // XOC flow: just create booking + send email, no payment
      try {
        const res = await fetch("/api/ref/createBooking", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          throw new Error("Failed to send booking request");
        }

        alert(
          "Your XOC booking request has been sent! I’ll contact you on Discord/email to confirm details."
        );
        navigate("/"); // or a thank-you page
      } catch (err) {
        console.error("Error sending XOC enquiry:", err);
        setErrorStep2(
          "Could not send your request. Please try again or reach out on Discord."
        );
      }
    } else {
      // Normal flow: go to payment page
      navigate(`/payment?data=${encodeURIComponent(JSON.stringify(payload))}`);
    }
  };

  // ---------- CALENDAR DATA ----------
  const startOfMonth = new Date(month.getFullYear(), month.getMonth(), 1);
  const endOfMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0);
  const daysInMonth = Array.from(
    { length: endOfMonth.getDate() },
    (_, i) => i + 1
  );

  return (
    <div className="text-white">
      {!settings ? (
        <div className="text-center text-sky-300 mt-20">
          Loading booking settings...
        </div>
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

          {step === 1 && (
            <div className="max-w-3xl mx-auto backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl p-8 text-center shadow-[0_0_25px_rgba(14,165,233,0.15)]">
              <h3 className="text-sky-300 text-lg font-semibold mb-2">
                Select a Date and Time for Your Session
              </h3>
              <p className="text-xs text-sky-400/70 mb-5">
                Times are shown in{" "}
                <span className="font-semibold">your local time</span> (
                {userTimeZone}), based on host availability in{" "}
                <span className="font-semibold">India (IST)</span>.
              </p>

              <div className="flex flex-col sm:flex-row gap-8 justify-center">
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <button
                      onClick={() =>
                        setMonth(
                          new Date(month.getFullYear(), month.getMonth() - 1, 1)
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
                          new Date(month.getFullYear(), month.getMonth() + 1, 1)
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

                      const maxDate = new Date();
                      maxDate.setDate(
                        maxDate.getDate() + (settings.maxDaysAheadBooking || 7)
                      );
                      maxDate.setHours(0, 0, 0, 0);

                      const disabled = date < startOfToday || date > maxDate;
                      const isSelected =
                        selectedDate && isSameDay(date, selectedDate);

                      return (
                        <button
                          key={day}
                          disabled={disabled}
                          onClick={() => handleDayClick(day)}
                          className={`p-2 rounded-lg transition-all duration-200 ${
                            isSelected
                              ? "bg-sky-600 text-white shadow-[0_0_12px_rgba(56,189,248,0.6)]"
                              : disabled
                              ? "text-slate-500 cursor-not-allowed"
                              : "hover:bg-sky-700/40 text-sky-200"
                          }`}
                        >
                          {day}
                        </button>
                      );
                    })}
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

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      {times.map((t) => (
                        <button
                          key={t.hostLabel}
                          onClick={() => !t.disabled && setSelectedSlot(t)}
                          disabled={t.disabled}
                          className={`py-2 rounded-lg border transition-all duration-200 ${
                            t.isBooked
                              ? "bg-red-900/40 border-red-700/40 text-red-400 cursor-not-allowed"
                              : t.disabled
                              ? "bg-slate-800/40 text-slate-500 border-slate-700/50 cursor-not-allowed"
                              : selectedSlot?.hostLabel === t.hostLabel
                              ? "bg-sky-600 text-white border-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.6)]"
                              : "border-sky-700/40 hover:border-sky-500/60 hover:bg-sky-700/20"
                          }`}
                        >
                          {t.localLabel}
                          <span className="block text-[10px] text-sky-400/70 mt-1">
                            ({t.hostLabel} IST)
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <button
                onClick={() => {
                  if (!selectedDate || !selectedSlot) {
                    setErrorStep1(
                      "Please select a date and time before continuing."
                    );
                    return;
                  }
                  setErrorStep1("");
                  setStep(2);
                }}
                className={`mt-10 w-full sm:w-64 mx-auto py-3 rounded-lg font-semibold text-lg transition-all duration-300 ${
                  !selectedDate || !selectedSlot
                    ? "bg-sky-800 text-sky-200/70 cursor-not-allowed"
                    : "bg-gradient-to-r from-sky-500 to-blue-700 hover:from-sky-400 hover:to-blue-600 shadow-[0_0_20px_rgba(14,165,233,0.4)]"
                }`}
              >
                Next
              </button>

              {errorStep1 && (
                <p className="text-red-400 mt-3 text-sm">{errorStep1}</p>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="max-w-2xl mx-auto bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl p-8 shadow-[0_0_25px_rgba(14,165,233,0.15)] space-y-6">
              <input
                name="discord"
                placeholder="Discord (e.g. Servi#1234)"
                onChange={handleChange}
                className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 focus:outline-none focus:border-sky-500 transition"
              />
              <input
                name="email"
                type="email"
                placeholder="Email"
                onChange={handleChange}
                className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 focus:outline-none focus:border-sky-500 transition"
              />
              <input
                name="specs"
                placeholder="PC Specs"
                onChange={handleChange}
                className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 focus:outline-none focus:border-sky-500 transition"
              />
              <input
                name="mainGame"
                placeholder="Main use case (Game/Apps)"
                onChange={handleChange}
                className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 focus:outline-none focus:border-sky-500 transition"
              />

              <textarea
                name="notes"
                placeholder="Any extra requirements?"
                onChange={handleChange}
                className="w-full bg-[#0b1120]/60 border border-sky-700/30 rounded-lg p-3 h-24 focus:outline-none focus:border-sky-500 transition"
              ></textarea>

              <p className="text-sky-400/60 text-xs">
                Please read the FAQ before booking — it answers everything you
                need to know.
              </p>

              <div className="flex justify-between gap-4">
                <button
                  onClick={() => setStep(1)}
                  className="w-1/2 bg-slate-700/40 hover:bg-slate-700/60 py-3 rounded-lg font-semibold transition"
                >
                  Back
                </button>

                <button
                  onClick={async () => {
                    if (
                      !form.discord.trim() ||
                      !form.email.trim() ||
                      !form.specs.trim() ||
                      !form.mainGame.trim()
                    ) {
                      setErrorStep2("Please fill out all required fields.");
                      return;
                    }
                    setErrorStep2("");
                    setLoading(true);
                    await handleSubmit();
                    setLoading(false);
                  }}
                  disabled={loading}
                  className="w-1/2 bg-gradient-to-r from-sky-500 to-blue-700 hover:from-sky-400 hover:to-blue-600 py-3 rounded-lg font-semibold transition"
                >
                  {loading
                    ? isXoc
                      ? "Sending..."
                      : "Submitting..."
                    : isXoc
                    ? "Send Request"
                    : "Submit & Pay"}
                </button>
              </div>

              {errorStep2 && (
                <p className="text-red-400 text-sm mt-3">{errorStep2}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
