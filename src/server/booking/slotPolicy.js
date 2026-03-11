import { createRefReadClient } from "../api/ref/sanity.js";

export const BOOKING_SETTINGS_ID = "6d8a3646-0ed2-44b5-ad45-c5c9d578126a";
export const OWNER_TZ_NAME = "Asia/Kolkata";

const SETTINGS_QUERY = `*[_id == $id && _type == "bookingSettings"][0]{
  dateSlots,
  xocDateSlots,
  vertexEssentialsDateSlots,
  packageDateSlots[]{
    package->{_id,title},
    dateSlots
  }
}`;

const buildOwnerParts = (utcDate, timeZone = OWNER_TZ_NAME) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(utcDate)
    .reduce((acc, cur) => {
      acc[cur.type] = cur.value;
      return acc;
    }, {});

export const formatOwnerDateLabel = (utcDate, timeZone = OWNER_TZ_NAME) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "2-digit",
      year: "numeric",
    })
      .formatToParts(utcDate)
      .reduce((acc, cur) => {
        acc[cur.type] = cur.value;
        return acc;
      }, {});
    return `${parts.weekday || ""} ${parts.month || ""} ${parts.day || ""} ${parts.year || ""}`.trim();
  } catch (err) {
    console.error("Failed to format owner date label", err);
    return "";
  }
};

export const formatOwnerTimeLabel = (utcDate, timeZone = OWNER_TZ_NAME) => {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(utcDate);
  } catch (err) {
    console.error("Failed to format owner time label", err);
    return "";
  }
};

const normalizeDateKey = (value) => {
  if (!value) return "";
  const raw = String(value).trim();
  const datePart = raw.split("T")[0];
  const match = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    return `${match[1]}-${match[2]}-${match[3]}`;
  }

  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) return "";
  const year = String(parsed.getFullYear());
  const month = String(parsed.getMonth() + 1).padStart(2, "0");
  const day = String(parsed.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const parseHourValue = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{1,2})(?::\d{2})?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  return hour;
};

export const normalizePackageKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const sanitizeTimes = (times) =>
  Array.isArray(times)
    ? times.map((time) => String(time || "").trim()).filter(Boolean)
    : [];

export const sanitizeSlots = (slots) =>
  Array.isArray(slots)
    ? slots
        .map((slot) => ({
          date: normalizeDateKey(slot?.date),
          times: sanitizeTimes(slot?.times),
        }))
        .filter((slot) => slot.date && slot.times.length > 0)
    : [];

export const sanitizePackageDateSlots = (entries) =>
  Array.isArray(entries)
    ? entries
        .map((entry) => ({
          package:
            entry?.package?._id && entry?.package?.title
              ? {
                  _id: String(entry.package._id),
                  title: String(entry.package.title),
                }
              : null,
          dateSlots: sanitizeSlots(entry?.dateSlots),
        }))
        .filter((entry) => entry.package && entry.dateSlots.length > 0)
    : [];

export const normalizeDateSlots = (slots) => {
  const map = {};

  for (const slot of sanitizeSlots(slots)) {
    const hours = slot.times
      .map((time) => parseHourValue(time))
      .filter((time) => Number.isFinite(time));
    const uniqueHours = [...new Set(hours)].sort((a, b) => a - b);
    if (!uniqueHours.length) continue;
    map[slot.date] = uniqueHours;
  }

  return map;
};

export const normalizePackageDateSlots = (entries) => {
  const map = {};

  for (const entry of sanitizePackageDateSlots(entries)) {
    const titleKey = normalizePackageKey(entry?.package?.title);
    if (!titleKey) continue;
    const slots = normalizeDateSlots(entry.dateSlots);
    if (!Object.keys(slots).length) continue;
    map[titleKey] = slots;
  }

  return map;
};

export const sanitizeBookingSettings = (settings = {}) => ({
  dateSlots: sanitizeSlots(settings?.dateSlots),
  xocDateSlots: sanitizeSlots(settings?.xocDateSlots),
  vertexEssentialsDateSlots: sanitizeSlots(settings?.vertexEssentialsDateSlots),
  packageDateSlots: sanitizePackageDateSlots(settings?.packageDateSlots),
});

export const normalizeBookingSettings = (settings = {}) => {
  const sanitized = sanitizeBookingSettings(settings);
  return {
    ...sanitized,
    dateSlotMap: normalizeDateSlots(sanitized.dateSlots),
    xocDateSlotMap: normalizeDateSlots(sanitized.xocDateSlots),
    vertexEssentialsDateSlotMap: normalizeDateSlots(
      sanitized.vertexEssentialsDateSlots
    ),
    packageDateSlotMaps: normalizePackageDateSlots(sanitized.packageDateSlots),
  };
};

export const isXocPackageTitle = (title) =>
  normalizePackageKey(title).includes("xoc");

export const isVertexEssentialsPackageTitle = (title) =>
  normalizePackageKey(title).includes("vertex essential");

export const resolvePackageSlotMap = (settings, packageTitle = "") => {
  const normalizedSettings = normalizeBookingSettings(settings);
  const packageTitleKey = normalizePackageKey(packageTitle);
  const packageMap = packageTitleKey
    ? normalizedSettings.packageDateSlotMaps?.[packageTitleKey]
    : null;
  const baseMap = normalizedSettings.dateSlotMap;
  const xocMap = normalizedSettings.xocDateSlotMap;
  const essentialsMap = normalizedSettings.vertexEssentialsDateSlotMap;
  const hasBase = !!baseMap && Object.keys(baseMap).length > 0;
  const hasXoc = !!xocMap && Object.keys(xocMap).length > 0;
  const hasEssentials = !!essentialsMap && Object.keys(essentialsMap).length > 0;
  const hasPackageMap = !!packageMap && Object.keys(packageMap).length > 0;
  const isXoc = isXocPackageTitle(packageTitle);
  const isVertexEssentials = isVertexEssentialsPackageTitle(packageTitle);

  if (hasPackageMap) return packageMap;
  if (isXoc && hasXoc) return xocMap;
  if (isVertexEssentials && hasEssentials) return essentialsMap;
  if (!isXoc && hasBase) return baseMap;
  if (hasBase) return baseMap;
  if (hasEssentials) return essentialsMap;
  if (hasXoc) return xocMap;
  return null;
};

export const getOwnerSlotDetails = (value, timeZone = OWNER_TZ_NAME) => {
  const utcDate = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(utcDate.getTime())) {
    return {
      dateKey: "",
      hour: null,
      hostDate: "",
      hostTime: "",
    };
  }

  const parts = buildOwnerParts(utcDate, timeZone);
  return {
    dateKey: `${parts.year || ""}-${parts.month || ""}-${parts.day || ""}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    hostDate: formatOwnerDateLabel(utcDate, timeZone),
    hostTime: formatOwnerTimeLabel(utcDate, timeZone),
  };
};

export const isBookingBlockingStatus = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    !normalized ||
    normalized === "pending" ||
    normalized === "captured" ||
    normalized === "completed"
  );
};

export const filterActiveBookings = (bookings) =>
  (Array.isArray(bookings) ? bookings : []).filter((booking) =>
    isBookingBlockingStatus(booking?.status)
  );

export const isSlotAllowedForPackage = ({
  settings,
  packageTitle = "",
  startTimeUTC,
}) => {
  const slotMap = resolvePackageSlotMap(settings, packageTitle);
  const ownerSlot = getOwnerSlotDetails(startTimeUTC);
  const allowedHours = slotMap?.[ownerSlot.dateKey] || [];
  return {
    ...ownerSlot,
    slotMap,
    allowedMinute: ownerSlot.minute === 0,
    allowed: Array.isArray(allowedHours)
      ? ownerSlot.minute === 0 && allowedHours.includes(ownerSlot.hour)
      : false,
  };
};

export const getBookingSettings = async ({ client } = {}) => {
  const readClient = client || createRefReadClient();
  const settings = await readClient.fetch(SETTINGS_QUERY, {
    id: BOOKING_SETTINGS_ID,
  });

  if (!settings) {
    throw new Error("Missing booking settings.");
  }

  return normalizeBookingSettings(settings);
};
