const COUNTED_KEY = "roo-checkouts-counted";
const KEPT = 20;

const countedCheckouts = (stored) => {
  try {
    const counted = JSON.parse(stored || "[]");
    return Array.isArray(counted) ? counted : [];
  } catch {
    return [];
  }
};

const claimCheckout = (key) => {
  try {
    const counted = countedCheckouts(window.localStorage.getItem(COUNTED_KEY));
    if (counted.includes(key)) return false;
    window.localStorage.setItem(COUNTED_KEY, JSON.stringify([...counted, key].slice(-KEPT)));
    return true;
  } catch {
    return null;
  }
};

export const countCheckoutStart = async (data, provider) => {
  const created = data?.checkoutCreated === true;
  const orderId = String(data?.providerPayload?.orderId || "").trim();
  if (!orderId) return created;
  const key = `${provider}:${orderId}`;
  const claimed = navigator.locks
    ? await navigator.locks.request(COUNTED_KEY, () => claimCheckout(key))
    : claimCheckout(key);
  return created || claimed === true;
};
