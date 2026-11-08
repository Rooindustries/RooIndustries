import { paymentSession } from "../../public/checkout-state.js";

export const parseCheckoutFingerprint = (value) => {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
};

export const paymentSessionMatchesCheckout = (storedFingerprint, currentFingerprint) => {
  if (storedFingerprint === currentFingerprint) return true;
  const stored = parseCheckoutFingerprint(storedFingerprint);
  const current = parseCheckoutFingerprint(currentFingerprint);
  if (!stored || !current) return false;
  return ["packageTitle", "originalOrderId", "startTimeUTC", "email"].every(
    (key) => String(stored[key] || "") === String(current[key] || "")
  );
};

const readStoredPaymentSession = () => {
  try {
    const parsed = paymentSession.read();
    if (
      parsed?.paymentAccessToken &&
      parsed?.provider &&
      parsed?.fingerprint &&
      parsed?.providerPayload
    ) {
      return parsed;
    }
  } catch {}
  return null;
};

export const writeStoredPaymentSession = (session, unsaved) => {
  if (!session?.paymentAccessToken || !session?.provider ||
      !session?.fingerprint || !session?.providerPayload) return false;
  const saved = paymentSession.write(session);
  for (const [token, candidate] of unsaved) {
    if (paymentSessionMatchesCheckout(candidate.fingerprint, session.fingerprint)) unsaved.delete(token);
  }
  if (!saved) unsaved.set(session.paymentAccessToken, session);
  return saved;
};

export const clearStoredPaymentSession = (session) => {
  const stored = readStoredPaymentSession();
  if (!session || stored?.paymentAccessToken !== session.paymentAccessToken) return;
  try {
    paymentSession.remove(candidate => paymentSessionMatchesCheckout(candidate?.fingerprint, session.fingerprint));
  } catch {}
};

export const readCheckoutPaymentSession = (fingerprint, unsaved) => {
  const pending = [...unsaved.values()].find(
    session => paymentSessionMatchesCheckout(session.fingerprint, fingerprint)
  );
  if (pending) return pending;
  const stored = readStoredPaymentSession();
  return stored && paymentSessionMatchesCheckout(stored.fingerprint, fingerprint) ? stored : null;
};

export const readHoldPaymentSession = (hold) => {
  const session = readStoredPaymentSession();
  const fingerprint = parseCheckoutFingerprint(session?.fingerprint);
  if (!hold?.startTimeUTC || !hold?.packageTitle ||
      fingerprint?.startTimeUTC !== hold.startTimeUTC || fingerprint?.packageTitle !== hold.packageTitle) return null;
  const token = session?.result?.refreshedHold?.slotHoldToken || session?.result?.hold?.slotHoldToken;
  return token && token !== hold.holdToken ? null : session;
};
