import { bookingSalesAttribution } from "./analyticsModules";
import { reportRequestError } from "./clientRequest";

export const paymentStartBody = async ({ operation, provider, quoteFingerprint, salesAttribution, buildPayload }) => {
  const attribution = await bookingSalesAttribution(salesAttribution);
  if (!operation.current()) return "";
  return JSON.stringify({ provider, quoteFingerprint, bookingPayload: buildPayload(attribution) });
};

export const checkoutStartCounted = (data, provider) => import("./checkoutStartCount")
  .then(({ countCheckoutStart }) => countCheckoutStart(data, provider))
  .catch((error) => {
    reportRequestError(error);
    return data?.checkoutCreated === true;
  });
