import React from "react";

export const buildResetEmail = ({ name = "there", resetLink }) =>
  React.createElement(
    React.Fragment,
    null,
    React.createElement("p", null, `Hi ${name || "there"},`),
    React.createElement("p", null, "Use the button below to choose a new password."),
    React.createElement(
      "p",
      null,
      React.createElement(
        "a",
        { href: resetLink },
        React.createElement("strong", null, "Reset password")
      )
    ),
    React.createElement(
      "p",
      null,
      "This private link expires in one hour. If you did not request it, you can ignore this email."
    )
  );
