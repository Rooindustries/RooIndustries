const LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;

export const isValidEmail = (value) => {
  if (typeof value !== "string") return false;
  const email = value.trim();
  if (!email || email.length > 254 || /[\s\u0000-\u001f\u007f-\u009f]/.test(email)) return false;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@")) return false;
  const labels = email.slice(at + 1).split(".");
  return labels.length >= 2 && labels.every((label) => LABEL.test(label));
};
