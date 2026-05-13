import { finalizeProviderReturn } from "./flow.js";

const buildRedirectUrl = (req, path) => {
  const protocol = String(req.headers?.["x-forwarded-proto"] || "https")
    .split(",")[0]
    .trim();
  const host = String(req.headers?.["x-forwarded-host"] || req.headers?.host || "")
    .split(",")[0]
    .trim();
  if (!host) return path;
  return `${protocol}://${host}${path}`;
};

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", ["GET", "POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const result = await finalizeProviderReturn({
    query: req.query,
    body: req.body,
  });
  const status = String(result.body?.status || "").trim().toLowerCase();
  const ok =
    result.httpStatus >= 200 &&
    result.httpStatus < 300 &&
    (status === "booked" || status === "email_partial");

  if (ok) {
    return res.redirect(buildRedirectUrl(req, "/payment-success"), 303);
  }

  const code = encodeURIComponent(
    result.body?.code || result.body?.recoveryReason || "payment_failed"
  );
  return res.redirect(buildRedirectUrl(req, `/payment?paymentError=${code}`), 303);
}
