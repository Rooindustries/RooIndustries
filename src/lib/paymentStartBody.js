import { bookingSalesAttribution } from "./analyticsModules";

export const paymentStartBody = async ({ operation, provider, quoteFingerprint, salesAttribution, buildPayload }) => {
  const attribution = await bookingSalesAttribution(salesAttribution);
  if (!operation.current()) return "";
  return JSON.stringify({ provider, quoteFingerprint, bookingPayload: buildPayload(attribution) });
};
