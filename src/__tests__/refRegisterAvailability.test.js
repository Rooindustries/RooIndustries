import { resolveReferralCodeAvailability } from "../components/RefRegister";

describe("referral registration code availability", () => {
  test("treats only the registration availability contract as available", () => {
    expect(
      resolveReferralCodeAvailability(
        { ok: true, status: 200 },
        { ok: false, error: "Not found", reason: "available" }
      )
    ).toBe(true);
    expect(
      resolveReferralCodeAvailability(
        { ok: true, status: 200 },
        { ok: true, referral: { code: "taken" } }
      )
    ).toBe(false);
    expect(
      resolveReferralCodeAvailability(
        { ok: true, status: 200 },
        { ok: false, error: "Referral code already taken", reason: "reserved" }
      )
    ).toBe(false);
    expect(
      resolveReferralCodeAvailability(
        { ok: true, status: 200 },
        { ok: false, error: "Not found", reason: "not_found" }
      )
    ).toBeNull();
  });

  test("keeps malformed and server failures indeterminate", () => {
    expect(
      resolveReferralCodeAvailability(
        { ok: false, status: 400 },
        { ok: false, error: "Missing code" }
      )
    ).toBeNull();
    expect(
      resolveReferralCodeAvailability(
        { ok: false, status: 500 },
        { ok: false, error: "Server error", reason: "not_found" }
      )
    ).toBeNull();
  });
});
