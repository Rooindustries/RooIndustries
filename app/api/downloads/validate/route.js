import { runLegacyApiHandler } from "@/src/lib/nextApiAdapter";
import { getClientAddress, requireRateLimit } from "@/src/server/api/ref/rateLimit";
import {
  createDownloadDataClient,
  validateDownloadAccess,
} from "@/src/server/downloads/downloadAccess";
import { DOWNLOAD_TOKEN_TTL_SECONDS } from "@/src/server/downloads/downloadToken";
import { logSafeError } from "@/src/server/safeErrorLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const handler = async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const body = req.body || {};
  const key = `download-validate:${getClientAddress(req)}`;
  if (
    !(await requireRateLimit(res, {
      key,
      max: 12,
      message: "Too many download lookup requests. Please try again later.",
    }))
  ) {
    return;
  }

  try {
    const result = await validateDownloadAccess({
      slug: body.slug,
      orderId: body.orderId,
      email: body.email,
      client: createDownloadDataClient(),
    });
    if (result.status === 200 && result.downloadToken) {
      res.setHeader(
        "Set-Cookie",
        [
          `download_access=${encodeURIComponent(result.downloadToken)}`,
          "Path=/api/downloads/file",
          "HttpOnly",
          "SameSite=Strict",
          process.env.NODE_ENV === "production" ? "Secure" : "",
          `Max-Age=${DOWNLOAD_TOKEN_TTL_SECONDS}`,
        ]
          .filter(Boolean)
          .join("; ")
      );
    }
    return res.status(result.status).json(result.body);
  } catch (error) {
    logSafeError("Download validation failed", error);
    return res.status(500).json({
      ok: false,
      error: "Server error while validating this download.",
    });
  }
};

export const POST = (request) =>
  runLegacyApiHandler({ request, handler, methodOverride: "POST" });
