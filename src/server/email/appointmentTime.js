export const formatAppointmentTime = (instant, requestedTimeZone) => {
  const date = new Date(String(instant || "").trim());
  if (!Number.isFinite(date.getTime())) return null;

  let timeZone = String(requestedTimeZone || "").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(date);
  } catch {
    timeZone = "UTC";
  }
  const offset = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date).find(part => part.type === "timeZoneName")?.value;
  return {
    date: new Intl.DateTimeFormat("en-US", {
      timeZone, weekday: "long", month: "long", day: "numeric", year: "numeric",
    }).format(date),
    shortDate: new Intl.DateTimeFormat("en-US", {
      timeZone, weekday: "short", month: "short", day: "2-digit", year: "numeric",
    }).format(date).replaceAll(",", ""),
    time: new Intl.DateTimeFormat("en-US", {
      timeZone, hour: "numeric", minute: "2-digit",
    }).format(date),
    timeZone: timeZone === "UTC" ? "UTC" : `${offset === "GMT" ? "GMT+00:00" : offset} (${timeZone})`,
  };
};
