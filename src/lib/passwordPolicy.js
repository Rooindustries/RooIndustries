// Supabase Auth's bcrypt limit is measured in UTF-8 bytes, not JavaScript string
// length. Apply this policy only when choosing a new password; existing login
// inputs and imported hashes must retain their compatibility behavior.
export const NEW_PASSWORD_REQUIREMENT =
  "Use at least 10 characters and at most 72 UTF-8 bytes.";

export const isValidNewPassword = (password) =>
  typeof password === "string" &&
  Array.from(password).length >= 10 &&
  new TextEncoder().encode(password).byteLength <= 72;
