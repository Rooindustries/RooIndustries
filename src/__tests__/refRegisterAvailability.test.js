import { resolveReferralCodeAvailability } from "../components/RefRegister";

describe("referral registration code availability", () => {
  test("treats only the quiet not_found contract as available", () => {
    expect(
      resolveReferralCodeAvailability(
        { ok: true, status: 200 },
        { ok: false, error: "Not found", reason: "not_found" }
      )
    ).toBe(true);
    expect(
      resolveReferralCodeAvailability(
        { ok: true, status: 200 },
        { ok: true, referral: { code: "taken" } }
      )
    ).toBe(false);
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
