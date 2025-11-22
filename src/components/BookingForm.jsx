import React, { useEffect, useMemo, useState } from "react";
import { client } from "../sanityClient";
import { useLocation, useNavigate } from "react-router-dom";

// read query params
function useQuery() {
  const { search } = useLocation();
  return new URLSearchParams(search);
}

const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const hLabel = (h) => {
  const ampm = h >= 12 ? "PM" : "AM";
  const disp = ((h + 11) % 12) + 1;
  return `${disp}:00 ${ampm}`;
};

export default function BookingForm() {
  const q = useQuery();
  const navigate = useNavigate();

  const [step, setStep] = useState(1);
  const [settings, setSettings] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const [selectedTime, setSelectedTime] = useState("");
  const [month, setMonth] = useState(new Date());
  const [loading, setLoading] = useState(false);
  const [errorStep1, setErrorStep1] = useState("");
  const [errorStep2, setErrorStep2] = useState("");

  const [form, setForm] = useState({
    discord: "",
    email: "",
    specs: "",
    mainGame: "",
    notes: "",
  });

  // ---------- FETCH SETTINGS ----------
  useEffect(() => {
    const fetchData = async () => {
      try {
        const [s, booked] = await Promise.all([
          client.fetch(`*[_type == "bookingSettings"][0]`),
          client.fetch(`*[_type == "booking"]{date, time}`),
        ]);

        if (!s) throw new Error("Missing bookingSettings in Sanity.");

        s.openHour = Number(s.openHour ?? 9);
        s.closeHour = Number(s.closeHour ?? 21);
        s.windowHours = Number(
          s.maxHoursAheadBooking ?? s.minHoursBeforeBooking ?? 2
        );

        s.bookedSlots = booked;
        setSettings(s);
      } catch (err) {
        console.error("Error fetching booking data:", err);
      }
    };

    fetchData();
  }, []);

  // ---------- MEMOS ----------
  const selectedPackage = useMemo(
    () => ({
      title: q.get("title") || "",
      price: q.get("price") || "",
      tag: q.get("tag") || "",
    }),
    [q]
  );

  const startOfToday = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);

  const times = useMemo(() => {
    if (!settings || !selectedDate) return [];

    const dayName = selectedDate
      .toLocaleDateString("en-US", { weekday: "long" })
      .toLowerCase();

    const allowedRaw = settings.availableTimes?.[dayName] || [];
    const allowed = allowedRaw.map((x) => Number(x));

    const open = settings.openHour ?? 0;
    const close = settings.closeHour ?? 23;

    const dateLabel = selectedDate.toDateString();
    const bookedForDay =
      settings.bookedSlots
        ?.filter((b) => b.date === dateLabel)
        .map((b) => b.time) || [];

    const slots = [];
    for (let h = open; h <= close; h++) {
      const label = hLabel(h);
      const isAllowed = allowed.includes(h);
      const isBooked = bookedForDay.includes(label);

      const disabled = !isAllowed || isBooked;

      slots.push({ label, hour: h, disabled, isBooked, isAllowed });
    }

    return slots;
  }, [settings, selectedDate]);

  // ---------- INITIAL DATE ----------
  useEffect(() => {
    if (settings && !selectedDate) {
      setSelectedDate(new Date());
      setMonth(new Date());
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
    setSelectedTime("");
  };

  // ---------- SUBMIT ----------
  const handleSubmit = async () => {
    if (!selectedDate || !selectedTime) return;

    const payload = {
      date: selectedDate.toDateString(),
      time: selectedTime,
      discord: form.discord.trim(),
      email: form.email.trim(),
      specs: form.specs.trim(),
      mainGame: form.mainGame.trim(),
      message: form.notes.trim(),
      packageTitle: selectedPackage.title,
      packagePrice: selectedPackage.price,
      status: "pending",
    };

    navigate(`/payment?data=${encodeURIComponent(JSON.stringify(payload))}`);
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
          {/* PACKAGE SUMMARY */}
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

          {/* STEP 1 -- Calendar & Time */}
          {step === 1 && (
            <div className="max-w-3xl mx-auto backdrop-blur-sm bg-[#0b1120]/80 border border-sky-700/30 rounded-2xl p-8 text-center shadow-[0_0_25px_rgba(14,165,233,0.15)]">
              <h3 className="text-sky-300 text-lg font-semibold mb-5">
                Select a Date and Time for Your Session
              </h3>
              <div className="flex flex-col sm:flex-row gap-8 justify-center">
                {/* Calendar */}
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
                      {month.toLocaleString("default", { month: "long" })}{" "}
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
                        maxDate.getDate() + settings.maxDaysAheadBooking
                      );

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

                {/* Time selection */}
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
                          key={t.label}
                          onClick={() =>
                            !t.disabled && setSelectedTime(t.label)
                          }
                          disabled={t.disabled}
                          className={`py-2 rounded-lg border transition-all duration-200 ${
                            t.isBooked
                              ? "bg-red-900/40 border-red-700/40 text-red-400 cursor-not-allowed"
                              : t.disabled
                              ? "bg-slate-800/40 text-slate-500 border-slate-700/50 cursor-not-allowed"
                              : selectedTime === t.label
                              ? "bg-sky-600 text-white border-sky-400 shadow-[0_0_15px_rgba(56,189,248,0.6)]"
                              : "border-sky-700/40 hover:border-sky-500/60 hover:bg-sky-700/20"
                          }`}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              {/* NEXT BUTTON */}
              <button
                onClick={() => {
                  if (!selectedDate || !selectedTime) {
                    setErrorStep1(
                      "Please select a date and time before continuing."
                    );
                    return;
                  }
                  setErrorStep1("");
                  setStep(2);
                }}
                className={`mt-10 w-full sm:w-64 mx-auto py-3 rounded-lg font-semibold text-lg transition-all duration-300 ${
                  !selectedDate || !selectedTime
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

          {/* STEP 2 -- USER INFO */}
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
                  onClick={() => {
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
                    handleSubmit();
                  }}
                  disabled={loading}
                  className="w-1/2 bg-gradient-to-r from-sky-500 to-blue-700 hover:from-sky-400 hover:to-blue-600 py-3 rounded-lg font-semibold transition"
                >
                  {loading ? "Submitting..." : "Submit & Pay"}
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
