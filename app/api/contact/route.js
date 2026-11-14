import { runLegacyApiHandler } from "../../../src/lib/nextApiAdapter";
import { getClientAddress, requireRateLimit } from "../../../src/server/api/ref/rateLimit";
import { submitContactMessage } from "../../../src/server/contact/contactMessages";
import { logSafeError } from "../../../src/server/safeErrorLog";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BODY_LIMIT = 16 * 1024;
const UNAVAILABLE = "We couldn't save your message right now.";

const reply = (res, status, payload) => {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(payload);
};

const handler = async (req, res) => {
  if (Buffer.byteLength(req.rawBody || "") > BODY_LIMIT) {
    return reply(res, 413, { ok: false, error: "Your message is too long." });
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
      company: body.company,
      clientAddress,
    });
    if (result.status === "queued") return reply(res, 202, { ok: true, queued: true });
    return reply(res, 200, { ok: true });
  } catch (error) {
    if (error?.code === "contact_invalid") return reply(res, 400, { ok: false, fields: error.fields });
    logSafeError("contact_message_record_failed", error);
    return reply(res, 503, { ok: false, error: UNAVAILABLE });
  }
};

export async function POST(request) {
  const response = await runLegacyApiHandler({ request, handler });
  response.headers.set("Cache-Control", "no-store");
  return response;
}
