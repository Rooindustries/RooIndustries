import { runLegacyApiHandler } from "../../../src/lib/nextApiAdapter";
import { getClientAddress, requireRateLimit } from "../../../src/server/api/ref/rateLimit";
import { submitContactMessage } from "../../../src/server/contact/contactMessages";
import { logSafeError } from "../../../src/server/safeErrorLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT = 16 * 1024;
const UNAVAILABLE = "We couldn't save your message right now.";

const handler = async (req, res) => {
  if (Buffer.byteLength(req.rawBody || "") > BODY_LIMIT) {
    return res.status(413).json({ ok: false, error: "Your message is too long." });
  }
  const body = req.body || {};
  const clientAddress = getClientAddress(req);
  const allowed = await requireRateLimit(res, {
    key: `contact-message:${clientAddress}`,
    windowMs: 900000,
    max: 5,
    message: "Too many messages. Please try again later.",
  });
  if (!allowed) return undefined;
  try {
    const result = await submitContactMessage({
      name: body.name,
      email: body.email,
      message: body.message,
      contactCheck: body.contact_check,
      clientAddress,
    });
    if (result.status === "queued") return res.status(202).json({ ok: true, queued: true });
    return res.status(200).json({ ok: true });
  } catch (error) {
    if (error?.code === "contact_invalid") return res.status(400).json({ ok: false, fields: error.fields });
    logSafeError("contact_message_record_failed", error);
    return res.status(503).json({ ok: false, error: UNAVAILABLE });
  }
};

export async function POST(request) {
  const response = await runLegacyApiHandler({ request, handler });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
