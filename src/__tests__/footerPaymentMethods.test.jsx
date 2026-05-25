import React from "react";
import { render, screen } from "@testing-library/react";
import Footer from "../components/Footer";

let mockLocation = {
  pathname: "/",
  search: "",
};
let mockMarket = {
  id: "global",
};

jest.mock("react-router-dom", () => ({
  __esModule: true,
  Link: ({ to, children, ...rest }) => (
    <a href={typeof to === "string" ? to : to?.pathname || "#"} {...rest}>
      {children}
    </a>
  ),
  useLocation: () => mockLocation,
}), { virtual: true });

jest.mock("../lib/market", () => ({
  resolveCurrentMarket: () => mockMarket,
}));

describe("footer payment methods", () => {
  beforeEach(() => {
    mockLocation = {
      pathname: "/",
      search: "",
    };
    mockMarket = {
      id: "global",
    };
  });

  test("India footer shows supported payment methods instead of generic checkout copy", () => {
    mockMarket = {
      id: "india",
    };

    render(<Footer />);

    expect(screen.getByLabelText("Accepted payment methods in India")).toBeInTheDocument();
    expect(screen.getByAltText("Visa")).toBeInTheDocument();
    expect(screen.getByAltText("Mastercard")).toBeInTheDocument();
    expect(screen.getByAltText("UPI")).toBeInTheDocument();
    expect(screen.getByAltText("RuPay")).toBeInTheDocument();
    expect(screen.getByAltText("Netbanking icon")).toBeInTheDocument();
    expect(screen.getByAltText("Wallets icon")).toBeInTheDocument();
    expect(screen.getByText("Netbanking")).toBeInTheDocument();
    expect(screen.getByText("Wallets")).toBeInTheDocument();
    expect(screen.queryByText("India checkout")).not.toBeInTheDocument();
  });
});
