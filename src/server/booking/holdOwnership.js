export const holdOwnsSlot = (hold, now = Date.now()) => {
  if (!hold) return false;
  const phase = String(hold.phase || "active").trim().toLowerCase();
  if (phase === "payment_pending") return true;
  if (phase === "released" || phase === "consumed") return false;
  const expiresAt = new Date(hold.expiresAt || "").getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
};
