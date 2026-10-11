const messages = {
  email: "Enter a valid booking email address.",
  discord: "Enter your Discord username.",
  specs: "Enter your PC specifications.",
  mainGame: "Enter your main game or app.",
  message: "Booking notes must be text.",
  localTimeZone: "Select a valid timezone.",
};

const reject = (field) => {
  throw Object.assign(new Error(messages[field]), {
    status: 400,
    code: `invalid_booking_${field}`,
  });
};

export const validateBookingContact = (payload, { fields = Object.keys(messages) } = {}) => {
  const contact = {};
  for (const field of fields) {
    const value = payload[field];
    if (field === "message" && value === undefined) continue;
    if (typeof value !== "string") reject(field);
    const trimmed = value.trim();
    if (field !== "message" && !trimmed) reject(field);
    if (field === "email" && (
      trimmed.length > 254 ||
      /[\u0000-\u001f\u007f-\u009f]/.test(value) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ||
      trimmed.split("@")[1].split(".").some((label) => !/^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u.test(label))
    )) reject(field);
    if (field === "localTimeZone") {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
      } catch {
        reject(field);
      }
    }
    contact[field] = trimmed;
  }
  return contact;
};
