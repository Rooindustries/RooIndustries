import React from "react";
import { render, screen } from "@testing-library/react";
import UpgradeXoc from "../components/UpgradeXoc";

jest.mock("react-router-dom", () => ({
  useNavigate: () => jest.fn(),
}));

describe("upgrade eligibility accessibility", () => {
  test("associates input labels and preserves visible keyboard focus", () => {
    render(<UpgradeXoc />);

    const emailInput = screen.getByLabelText("Booking email");
    const orderInput = screen.getByLabelText("Enter your Order ID");

    [emailInput, orderInput].forEach((input) => {
      expect(input).toHaveClass(
        "focus-visible:outline-none",
        "focus-visible:ring-2",
        "focus-visible:ring-info-text",
        "focus-visible:ring-offset-2",
        "focus-visible:ring-offset-surface-card"
      );
    });
  });
});
