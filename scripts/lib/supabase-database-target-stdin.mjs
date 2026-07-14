import process from "node:process";

const MAX_PAYLOAD_BYTES = 16 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const inputError = (code) => Object.assign(
  new Error("The in-memory Supabase database target is invalid."),
  { code }
);

export const parseSupabaseDatabaseTargetPayload = (text) => {
  let payload;
  try {
    payload = JSON.parse(String(text || ""));
  } catch {
    throw inputError("TOURNEY_SUPABASE_DATABASE_STDIN_INVALID");
  }
  const keys = payload && typeof payload === "object" && !Array.isArray(payload)
    ? Object.keys(payload).sort()
    : [];
  if (keys.join(",") !== "expectedFingerprint,supabaseDatabaseUrl") {
    throw inputError("TOURNEY_SUPABASE_DATABASE_STDIN_INVALID");
  }
  const supabaseDatabaseUrl = String(payload.supabaseDatabaseUrl || "").trim();
  const expectedFingerprint = String(payload.expectedFingerprint || "").trim().toLowerCase();
  let parsed;
  try {
    parsed = new URL(supabaseDatabaseUrl);
  } catch {
    throw inputError("TOURNEY_SUPABASE_DATABASE_STDIN_INVALID");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.username ||
    !parsed.password ||
    !parsed.pathname.replace(/^\/+/, "") ||
    !SHA256_PATTERN.test(expectedFingerprint)
  ) {
    throw inputError("TOURNEY_SUPABASE_DATABASE_STDIN_INVALID");
  }
  return { supabaseDatabaseUrl, expectedFingerprint };
};

export const readSupabaseDatabaseTargetFromStdin = async ({
  input = process.stdin,
  maxBytes = MAX_PAYLOAD_BYTES,
} = {}) => {
  if (input.isTTY) {
    throw inputError("TOURNEY_SUPABASE_DATABASE_STDIN_REQUIRED");
  }
  const chunks = [];
  let bytes = 0;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw inputError("TOURNEY_SUPABASE_DATABASE_STDIN_TOO_LARGE");
    }
    chunks.push(chunk);
    const buffered = Buffer.concat(chunks);
    const newlineIndex = buffered.indexOf(0x0a);
    if (newlineIndex >= 0) {
      if (buffered.subarray(newlineIndex + 1).toString("utf8").trim()) {
        throw inputError("TOURNEY_SUPABASE_DATABASE_STDIN_INVALID");
      }
      return parseSupabaseDatabaseTargetPayload(
        buffered.subarray(0, newlineIndex).toString("utf8")
      );
    }
  }
  if (bytes === 0) {
    throw inputError("TOURNEY_SUPABASE_DATABASE_STDIN_REQUIRED");
  }
  return parseSupabaseDatabaseTargetPayload(Buffer.concat(chunks).toString("utf8"));
};

export const loadSupabaseDatabaseTargetFromStdin = async ({
  env = process.env,
  input = process.stdin,
} = {}) => {
  const target = await readSupabaseDatabaseTargetFromStdin({ input });
  env.SUPABASE_DATABASE_URL = target.supabaseDatabaseUrl;
  env.TOURNEY_CUTOVER_EXPECTED_SUPABASE_DATABASE_FINGERPRINT =
    target.expectedFingerprint;
};

export const expectedConnectedDatabaseUsername = (identity = {}) => {
  const hostname = String(identity.hostname || "").toLowerCase();
  const username = String(identity.username || "");
  const projectRef = String(identity.projectRef || "").toLowerCase();
  if (!hostname.endsWith(".pooler.supabase.com") || !projectRef) return username;
  const suffix = `.${projectRef}`;
  if (!username.toLowerCase().endsWith(suffix) || username.length === suffix.length) {
    return username;
  }
  return username.slice(0, -suffix.length);
};
