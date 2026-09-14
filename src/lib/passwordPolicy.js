export const NEW_PASSWORD_REQUIREMENT =
  "Use at least 10 characters and at most 72 UTF-8 bytes.";

export const isValidNewPassword = (password) =>
  typeof password === "string" &&
  Array.from(password).length >= 10 &&
  new TextEncoder().encode(password).byteLength <= 72;
