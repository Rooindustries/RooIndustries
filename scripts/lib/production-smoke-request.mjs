export class SmokeRequestRefusal extends Error {}
export class SmokeResponseError extends Error {}

export const smokeRequest = async (url, options = {}) => {
  if ((options.method || "GET").toUpperCase() !== "GET" || options.body != null) {
    throw new SmokeRequestRefusal("Production smoke requests must be GET-only.");
  }
  const target = new URL(url);
  const provider = /(?:^|\.)(?:paypal|razorpay|dodopayments)\.com$/.test(target.hostname);
  if (provider && /\/(?:orders?|payments?|checkouts?|subscriptions?)(?:\/|$)/i.test(decodeURIComponent(target.pathname))) {
    throw new SmokeRequestRefusal("Production smoke cannot request provider order or payment APIs.");
  }
  const response = await fetch(url, { ...options, method: "GET", redirect: "manual" });
  if (!response.ok) {
    await response.body?.cancel();
    throw new SmokeResponseError(`${new URL(url).pathname} answered ${response.status}`);
  }
  return response;
};
