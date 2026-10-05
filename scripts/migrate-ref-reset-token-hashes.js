const crypto = require("crypto");
const { createClient } = require("@sanity/client");
const { loadOperatorEnvironment } = require("./lib/operator-environment.cjs");

const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

async function main() {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf("--env");
  const envPath = envIndex >= 0 ? args[envIndex + 1] : "";
  const apply = args.includes("--apply");
  const flags = args.filter((_, index) => index !== envIndex + 1 || envIndex < 0);
  if (flags.some((arg) => !["--env", "--apply"].includes(arg))) throw new Error("Invalid reset-token migration arguments.");
  loadOperatorEnvironment(envPath);
  const readEnv = (...keys) => keys.map((key) => String(process.env[key] || "").trim()).find(Boolean) || "";
  const projectId = readEnv("SANITY_PRIVATE_PROJECT_ID", "SANITY_PROJECT_ID");
  const dataset = readEnv("SANITY_PRIVATE_DATASET", "SANITY_DATASET");
  const writeToken = readEnv("SANITY_PRIVATE_WRITE_TOKEN", "SANITY_WRITE_TOKEN");
  const token = apply ? writeToken : readEnv("SANITY_PRIVATE_READ_TOKEN", "SANITY_READ_TOKEN") || writeToken;
  if (!projectId || !dataset || !token) throw new Error("An explicit Sanity target and authenticated token are required.");
  const client = createClient({ projectId, dataset, token, useCdn: false, perspective: "raw",
    apiVersion: readEnv("SANITY_PRIVATE_API_VERSION", "SANITY_API_VERSION") || "2023-10-01" });
  const docs = await client.fetch(
    `*[_type == "referral" && defined(resetToken) && !defined(resetTokenHash)]{
      _id,
      _rev,
      resetToken
    }`
  );

  if (!Array.isArray(docs)) throw new Error("The legacy token inventory is invalid.");
  const legacyDocs = docs;
  if (!apply) {
    console.log(JSON.stringify({ mode: "dry-run", candidates: legacyDocs.length, migrated: 0, remaining: legacyDocs.length }));
    return;
  }
  if (!legacyDocs.length) {
    console.log(JSON.stringify({ migrated: 0, remaining: 0 }));
    return;
  }

  for (const doc of legacyDocs) {
    const resetToken = String(doc?.resetToken || "");
    if (!doc?._id || !doc._rev || typeof doc.resetToken !== "string" || !resetToken) throw new Error("A legacy token lacks revision or token evidence.");

    await client
      .patch(doc._id)
      .ifRevisionId(doc._rev)
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
