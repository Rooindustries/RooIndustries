import { requireReferralSession } from "./auth.js";

const createProbeResponse = () => ({
  statusCode: 200,
  body: null,
  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
  getHeader() {
    return undefined;
  },
  setHeader() {},
});

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const session = await requireReferralSession(req, createProbeResponse());
  return res.status(200).json({
    ok: true,
    authenticated: Boolean(session),
  });
}
