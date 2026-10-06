const fs = require("node:fs");
const path = require("node:path");
const dotenv = require("dotenv");

const prefixes = [
  "SUPABASE_", "NEXT_PUBLIC_SUPABASE_",
  "PAYPAL_", "NEXT_PUBLIC_PAYPAL_", "RAZORPAY_", "DODO_", "DOWNLOAD_",
  "BLOB_", "TOURNEY_", "COMMERCE_", "DATA_", "REFERRAL_",
  "VERCEL_BLOB_", "NEXT_PUBLIC_VERCEL_BLOB_",
];
const exactKeys = new Set(["CRON_SECRET", "VERCEL_OIDC_TOKEN"]);

const loadOperatorEnvironment = (envPath, { env = process.env } = {}) => {
  if (!envPath || String(envPath).startsWith("--")) {
    throw new Error("--env must name the exact private operator environment file.");
  }
  const resolved = path.resolve(envPath);
  const stats = fs.lstatSync(resolved);
  if (
    !stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stats.uid !== process.getuid())
  ) {
    throw new Error("The operator environment must be an owned private regular file.");
  }
  const parsed = dotenv.parse(fs.readFileSync(resolved));
  for (const key of Object.keys(env)) {
    if (prefixes.some((prefix) => key.startsWith(prefix)) || exactKeys.has(key)) delete env[key];
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (prefixes.some((prefix) => key.startsWith(prefix)) || exactKeys.has(key)) env[key] = value;
  }
  return resolved;
};

module.exports = { loadOperatorEnvironment };
