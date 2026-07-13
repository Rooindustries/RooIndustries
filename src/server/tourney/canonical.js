const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export const isEnabledTourneyFlag = (value) =>
  TRUE_VALUES.has(String(value || "").trim().toLowerCase());

export const stableTourneyJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableTourneyJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${stableTourneyJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
};
