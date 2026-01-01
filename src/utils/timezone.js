export const HOST_TZ_NAME = "Asia/Kolkata";

const defaultDateOptions = {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
};

const defaultTimeOptions = {
  hour: "numeric",
  minute: "2-digit",
};

export const formatInTimeZone = (utcDate, timeZone, options = {}) => {
  try {
    const fmt = new Intl.DateTimeFormat(undefined, {
      ...options,
      ...(timeZone ? { timeZone } : {}),
    });
    return fmt.format(utcDate);
  } catch (err) {
    console.error("Failed to format date in zone", err);
    return utcDate?.toString?.() || "";
  }
};

export const formatHostDateLabel = (utcDate, hostTimeZone = HOST_TZ_NAME) => {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: hostTimeZone,
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

    const day = parts.day || "";
    const weekday = parts.weekday || "";
    const month = parts.month || "";
    const year = parts.year || "";

    // Mirrors Date.prototype.toDateString() format while respecting the host timezone
    return `${weekday} ${month} ${day} ${year}`.trim();
  } catch (err) {
    console.error("Failed to format host date label", err);
    return utcDate?.toDateString?.() || "";
  }
};

export const deriveSlotLabels = (
  utcStart,
  userTimeZone,
  hostTimeZone = HOST_TZ_NAME
) => {
  const safeDate =
    utcStart instanceof Date ? utcStart : new Date(utcStart || undefined);

  if (!safeDate || isNaN(safeDate.getTime())) {
    return {
      localDateLabel: "",
      localTimeLabel: "",
      hostDateLabel: "",
      hostTimeLabel: "",
      crossesDateBoundary: false,
    };
  }

  const dateKey = (tz) => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      })
        .formatToParts(safeDate)
        .reduce((acc, cur) => {
          acc[cur.type] = cur.value;
          return acc;
        }, {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch (err) {
      console.error("Failed to compute date key", err);
      return "";
    }
  };

  const localDateKey = dateKey(userTimeZone);
  const hostDateKey = dateKey(hostTimeZone);

  const localDateLabel = formatInTimeZone(
    safeDate,
    userTimeZone,
    defaultDateOptions
  );
  const localTimeLabel = formatInTimeZone(
    safeDate,
    userTimeZone,
    defaultTimeOptions
  );
  const hostDateLabel = formatHostDateLabel(safeDate, hostTimeZone);
  const hostTimeLabel = formatInTimeZone(
    safeDate,
    hostTimeZone,
    defaultTimeOptions
  );

  return {
    localDateLabel,
    localTimeLabel,
    hostDateLabel,
    hostTimeLabel,
    crossesDateBoundary:
      !!localDateKey && !!hostDateKey && localDateKey !== hostDateKey,
  };
};
