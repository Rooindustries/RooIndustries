export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", ["POST"]);
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  return res.status(410).json({
    ok: false,
    code: "legacy_order_creation_retired",
    message: "This checkout session expired. Please restart checkout.",
  });
}
