import React from "react";

export const buildReferralVerificationEmail = ({ name = "there", verifyLink }) =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement("p", null, `Hi ${name || "there"},`),
    React.createElement(
      "p",
      null,
      "Confirm this email to finish creating your Roo Industries creator account."
    ),
    React.createElement(
      "p",
      null,
      React.createElement(
        "a",
        { href: verifyLink },
        React.createElement("strong", null, "Confirm creator account")
      )
    ),
    React.createElement(
      "p",
      null,
      "This private link expires in one hour. If you did not start this signup, you can ignore it."
    )
  );
