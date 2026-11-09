export const CHECKOUT_START_CONFLICT =
  "This checkout already started with its original price and codes. " +
  "Finish it or release the payment before changing codes.";

export const paymentStartIdentity = (booking = {}) => {
  let generation = booking.slotHoldToken || "";
  try {
    const encoded = generation.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
    const proof = JSON.parse(atob(encoded));
    if (proof.n) generation = JSON.stringify([proof.n, proof.be, proof.gen]);
  } catch {}
  return JSON.stringify([
    booking.packageTitle || "", booking.originalOrderId || "", booking.startTimeUTC || "",
    String(booking.email || "").trim().toLowerCase(),
    booking.originalOrderId ? booking.upgradeIntentToken || "" : [booking.slotHoldId || "", generation],
  ]);
};
