const COUNTED_KEY = "roo-checkouts-counted";
const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

const recentMarks = (stored, now) => {
  try {
    const marks = JSON.parse(stored || "{}");
    if (!marks || typeof marks !== "object" || Array.isArray(marks)) return {};
    return Object.fromEntries(Object.entries(marks).filter(([, at]) => Number.isFinite(at) && now - at < KEPT_MS));
  } catch {
    return {};
  }
};

const claimCheckout = (key) => {
  try {
    const now = Date.now();
    const marks = recentMarks(window.localStorage.getItem(COUNTED_KEY), now);
    if (Object.hasOwn(marks, key)) return false;
    window.localStorage.setItem(COUNTED_KEY, JSON.stringify({ ...marks, [key]: now }));
    return true;
  } catch {
    return null;
  }
};

export const countCheckoutStart = async (data, provider) => {
  const created = data?.checkoutCreated === true;
  const orderId = String(data?.providerPayload?.orderId || "").trim();
  if (!orderId) return created;
  const claim = () => claimCheckout(`${provider}:${orderId}`);
  const claimed = navigator.locks ? await navigator.locks.request(COUNTED_KEY, claim).catch(claim) : claim();
  return claimed ?? created;
};
