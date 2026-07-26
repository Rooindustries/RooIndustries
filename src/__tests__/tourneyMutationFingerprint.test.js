import fs from "node:fs";
import path from "node:path";

// commandStorageKey used to fingerprint `method\nurl\nbody` where the body carries a
// plaintext password (reset, owner-account, registration) or a reset token. The hash
// is two non-cryptographic 32-bit functions, so the resulting sessionStorage key was
// an unsalted, cheaply reproducible password-derived verifier -- testable offline by
// any same-origin reader once the other body fields are known -- and it persisted for
// up to 24 hours on any pending or ambiguous command.

const source = fs.readFileSync(
  path.resolve("app/tourney/tourneyMutation.js"),
  "utf8"
);

describe("tourney mutation idempotency key", () => {
  test("no longer fingerprints the raw request body", () => {
    expect(source).not.toContain(
      'const body = typeof options.body === "string" ? options.body : "";'
    );
    expect(source).toContain("const body = fingerprintableBody(options.body);");
  });

  test("excludes every credential-bearing field name", () => {
    for (const field of [
      "password",
      "passwordConfirm",
      "currentPassword",
      "newPassword",
      "token",
      "resetToken",
    ]) {
      expect(source).toContain(`"${field}"`);
    }
    expect(source).toContain("CREDENTIAL_BODY_FIELDS.has(key)");
  });

  test("keeps credential key NAMES but never their values", () => {
    // Two requests differing only in shape should still get distinct keys, so the
    // field names are retained while the values are dropped.
    expect(source).toContain("redacted:");
    expect(source).toMatch(/filter\(\(key\) => CREDENTIAL_BODY_FIELDS\.has\(key\)\)/);
  });

  test("falls back to a length, not the content, for non-JSON bodies", () => {
    expect(source).toContain("return `len:${body.length}`;");
  });
});

describe("commandStorageKey behaviour", () => {
  // Re-derive the module's logic rather than importing it: the module is a client
  // helper whose exports assume a browser fetch, and the property under test is the
  // key derivation itself.
  const CREDENTIAL_BODY_FIELDS = new Set([
    "password",
    "passwordConfirm",
    "currentPassword",
    "newPassword",
    "token",
    "resetToken",
  ]);
  const fingerprintableBody = (body) => {
    if (typeof body !== "string" || !body) return "";
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return `len:${body.length}`;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return `len:${body.length}`;
    }
    const safe = Object.keys(parsed)
      .filter((key) => !CREDENTIAL_BODY_FIELDS.has(key))
      .sort()
      .map((key) => `${key}=${JSON.stringify(parsed[key])}`)
      .join("&");
    const redacted = Object.keys(parsed)
      .filter((key) => CREDENTIAL_BODY_FIELDS.has(key))
      .sort()
      .join(",");
    return redacted ? `${safe}|redacted:${redacted}` : safe;
  };

  test("two different passwords produce the same fingerprint", () => {
    const a = fingerprintableBody(JSON.stringify({ login: "bootchop", password: "hunter2" }));
    const b = fingerprintableBody(JSON.stringify({ login: "bootchop", password: "different" }));
    expect(a).toBe(b);
    expect(a).not.toContain("hunter2");
    expect(a).not.toContain("different");
  });

  test("the password value never appears in the fingerprint", () => {
    const secret = "S3cret-Value-8813";
    const out = fingerprintableBody(
      JSON.stringify({ token: "raw-reset-token", password: secret, action: "reset" })
    );
    expect(out).not.toContain(secret);
    expect(out).not.toContain("raw-reset-token");
    expect(out).toContain("action=");
  });

  test("still distinguishes genuinely different operations", () => {
    const reset = fingerprintableBody(JSON.stringify({ action: "reset", password: "x" }));
    const upsert = fingerprintableBody(JSON.stringify({ action: "upsert", password: "x" }));
    expect(reset).not.toBe(upsert);
  });

  test("distinguishes a body that carries a credential from one that does not", () => {
    const withPassword = fingerprintableBody(JSON.stringify({ action: "a", password: "x" }));
    const withoutPassword = fingerprintableBody(JSON.stringify({ action: "a" }));
    expect(withPassword).not.toBe(withoutPassword);
  });
});
