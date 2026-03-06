const crypto = require("crypto");
const { createClient } = require("@sanity/client");

const client = createClient({
  projectId: process.env.SANITY_PROJECT_ID || "9g42k3ur",
  dataset: process.env.SANITY_DATASET || "production",
  apiVersion: process.env.SANITY_API_VERSION || "2023-10-01",
  token: process.env.SANITY_WRITE_TOKEN,
  useCdn: false,
});

const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

async function main() {
  const docs = await client.fetch(
    `*[_type == "referral" && defined(resetToken) && !defined(resetTokenHash)]{
      _id,
      resetToken
    }`
  );

  const legacyDocs = Array.isArray(docs) ? docs : [];
  if (!legacyDocs.length) {
    console.log(JSON.stringify({ migrated: 0, remaining: 0 }));
    return;
  }

  for (const doc of legacyDocs) {
    const resetToken = String(doc?.resetToken || "");
    if (!doc?._id || !resetToken) continue;

    await client
      .patch(doc._id)
      .set({ resetTokenHash: hashToken(resetToken) })
      .unset(["resetToken"])
      .commit();
  }

  const remaining = await client.fetch(
    `count(*[_type == "referral" && defined(resetToken) && !defined(resetTokenHash)])`
  );

  console.log(
    JSON.stringify({
      migrated: legacyDocs.length,
      remaining,
    })
  );
}

main().catch((error) => {
  console.error("[migrate-ref-reset-token-hashes] failed:", error.message);
  process.exit(1);
});
