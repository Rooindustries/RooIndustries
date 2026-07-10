import { createClient } from "@sanity/client";
import { getClientAddress, requireRateLimit } from "./rateLimit.js";
import { logSafeError } from "../../safeErrorLog.js";

const readClient = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_READ_TOKEN || process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
  perspective: "published",
});

export default async function handler(req, res) {
  if (String(req?.method || "").toUpperCase() !== "GET") {
    res.setHeader?.("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const raw = (req.query.code || "").trim();
    const code = raw.toLowerCase();
    const clientAddress = getClientAddress(req);

    if (
      !(await requireRateLimit(res, {
        key: `validate-referral:${clientAddress}`,
        max: 25,
        message: "Too many referral validation requests. Please try again later.",
      }))
    ) {
      return;
    }

    if (!readClient.config().projectId || !readClient.config().dataset) {
      logSafeError("Referral storage configuration missing", {
        code: "sanity_config_missing",
        status: 500,
      });
      return res.status(500).json({ ok: false, error: "Server misconfigured" });
    }

    if (!code)
      return res.status(400).json({ ok: false, error: "Missing code" });

    // return fields used in the frontend/payment logic
    const ref = await readClient.fetch(
      `*[_type == "referral" && slug.current == $code][0]{
        _id,
        name,
        "code": slug.current,
        currentCommissionPercent,
        currentDiscountPercent,
        isFirstTime
      }`,
      { code }
    );

    if (!ref) {
      return res.status(404).json({ ok: false, error: "Not found" });
    }

    return res.status(200).json({ ok: true, referral: ref });
  } catch (e) {
    logSafeError("Referral validation failed", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
