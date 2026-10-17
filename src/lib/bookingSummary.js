export const isBookingInstant = value => {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second] = parts;
  const calendar = new Date(0);
  calendar.setUTCFullYear(Number(year), Number(month), 0);
  const days = calendar.getUTCDate();
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60;
};

export const asBookingSummary = (value, bookingId) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.bookingId !== bookingId || !bookingId) return null;
  if (typeof value.packageTitle !== "string" || !value.packageTitle.trim() || value.packageTitle.length > 200 || !isBookingInstant(value.startTimeUTC)) return null;
  if (typeof value.localTimeZone !== "string" || !value.localTimeZone.trim()) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: value.localTimeZone }).format(0); } catch { return null; }
  return { bookingId, packageTitle: value.packageTitle, startTimeUTC: value.startTimeUTC, localTimeZone: value.localTimeZone };
};

export const formatBookingAppointment = summary => {
  const date = new Date(summary.startTimeUTC);
  const options = { timeZone: summary.localTimeZone, year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" };
  const dateTime = new Intl.DateTimeFormat("en-US", options).format(date);
  let offset = "";
  try {
    offset = new Intl.DateTimeFormat("en-US", { timeZone: summary.localTimeZone, timeZoneName: "longOffset" })
      .formatToParts(date).find(part => part.type === "timeZoneName")?.value.replace("GMT", "UTC") || "";
  } catch {}
  if (offset === "UTC") offset = "UTC+00:00";
  return { dateTime, zone: offset ? `${summary.localTimeZone} · ${offset}` : summary.localTimeZone };
};
