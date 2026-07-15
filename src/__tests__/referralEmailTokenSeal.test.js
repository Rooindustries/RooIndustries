import {
  sealReferralEmailToken,
  unsealReferralEmailToken,
} from "../server/api/ref/referralEmailTokenSeal";

const env = { REF_SESSION_SECRET: "s".repeat(48) };

describe("referral email token sealing", () => {
  test("round-trips a token without storing plaintext", () => {
    const token = "private-reset-token";
    const sealed = sealReferralEmailToken(token, env);

    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(token);
    expect(unsealReferralEmailToken(sealed, env)).toBe(token);
  });

  test("rejects tampering and a different runtime secret", () => {
    const sealed = sealReferralEmailToken("private-reset-token", env);
    const tampered = `${sealed.slice(0, -1)}${sealed.endsWith("A") ? "B" : "A"}`;

    expect(() => unsealReferralEmailToken(tampered, env)).toThrow(
      "Sealed referral email token is invalid."
    );
    expect(() =>
      unsealReferralEmailToken(sealed, {
        REF_SESSION_SECRET: "x".repeat(48),
      })
    ).toThrow("Sealed referral email token is invalid.");
  });
});
