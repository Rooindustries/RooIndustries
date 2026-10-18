export const classifyHoldResponse = ({ endpoint, status, ok, code, networkError = false, expired = false }) => {
  if (expired) return "clear";
  if (networkError) return "keep";
  if (endpoint === "release" && status === 409) return "keep";
  if (endpoint === "hold" && status === 409 && code === "hold_payment_in_progress") return "keep";
  if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) return "clear";
  if (status >= 200 && status < 300 && ok) return endpoint === "release" ? "clear" : "replace";
  return "keep";
};
