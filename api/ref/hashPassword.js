import bcrypt from "bcryptjs";
import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET,
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ ok: false });

  try {
    const { creatorId, password } = req.body;

    if (!creatorId || !password) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing creatorId or password" });
    }

    const hash = await bcrypt.hash(password, 10);

    await client
      .patch(creatorId)
      .set({
        creatorPassword: hash,
      })
      .commit();

    return res.json({ ok: true, hash });
  } catch (err) {
    console.log("HASHPASSWORD ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
