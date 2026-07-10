import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildResetEmail } from "../server/email/referralResetEmail";

describe("referral reset email", () => {
  test("React escapes customer content and keeps the reset token out of query parameters", () => {
    const resetLink =
      "https://www.rooindustries.com/referrals/reset#token=private-token";
    const markup = renderToStaticMarkup(
      buildResetEmail({ name: '<img src=x onerror="alert(1)">', resetLink })
    );

    expect(markup).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(markup).toContain("/referrals/reset#token=private-token");
    expect(markup).not.toContain("/referrals/reset?token=");
    expect(markup).not.toContain("<img");
  });
});
