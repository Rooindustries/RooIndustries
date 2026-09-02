const HOST_TIME_ZONE_OFFSET_MINUTES = 330;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const parseHour = (value) => {
  const match = String(value ?? "")
    .trim()
    .match(/^(\d{1,2})(?::([0-5]\d))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour < 0 || hour > 23) return null;
  return { hour, minute: Number(match[2] || 0) };
};

const toUtcStart = (dateValue, timeValue) => {
  const [year, month, day] = String(dateValue || "")
    .split("T")[0]
    .split("-")
    .map(Number);
  const time = parseHour(timeValue);
  if (!year || !month || !day || !time) return null;
  const value = new Date(
    Date.UTC(year, month - 1, day, time.hour, time.minute) -
      HOST_TIME_ZONE_OFFSET_MINUTES * MINUTE_MS
  );
  return Number.isNaN(value.getTime()) ? null : value;
};

const getScheduleGroups = (settings = {}) => [
  settings.dateSlots,
  settings.vertexEssentialsDateSlots,
  settings.xocDateSlots,
  ...(Array.isArray(settings.packageDateSlots)
    ? settings.packageDateSlots.map((entry) => entry?.dateSlots)
    : []),
];

const findNextAvailableSession = (availability, now) => {
  const occupied = new Set(
    (availability?.bookedSlots || [])
      .map((slot) => String(slot?.startTimeUTC || "").trim())
      .filter(Boolean)
  );
  const starts = new Map();

  getScheduleGroups(availability?.settings).forEach((slots) => {
    (slots || []).forEach((slot) => {
      (slot?.times || []).forEach((time) => {
        const start = toUtcStart(slot?.date, time);
        if (!start) return;
        const iso = start.toISOString();
        if (start.getTime() > now && !occupied.has(iso)) {
          starts.set(iso, start);
        }
      });
    });
  });

  return [...starts.values()].sort((left, right) => left - right)[0] || null;
};

export const getSessionAvailability = (availability, nowValue = Date.now()) => {
  const now = nowValue instanceof Date ? nowValue.getTime() : Number(nowValue);
  if (!Number.isFinite(now)) return null;

  const start = findNextAvailableSession(availability, now);
  if (!start) return null;

  const leadMs = start.getTime() - now;
  const isOnline = leadMs <= HOUR_MS;
  if (isOnline) {
    return {
      startTimeUTC: start.toISOString(),
      leadMs,
      isOnline,
      label: "Engineer Online",
    };
  }

  const hours = Math.ceil(leadMs / HOUR_MS);
  const label =
    hours < 24
      ? `Available in ${hours} hours`
      : `Available in ${Math.ceil(hours / 24)} ${
          Math.ceil(hours / 24) === 1 ? "day" : "days"
        }`;

  return {
    startTimeUTC: start.toISOString(),
    leadMs,
    isOnline,
    label,
  };
};
