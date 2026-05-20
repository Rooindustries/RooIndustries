import React from "react";
import { render, screen } from "@testing-library/react";

let mockLocation = {
  pathname: "/",
  search: "",
  hash: "",
  state: null,
};
const mockNavigate = jest.fn();

jest.mock(
  "react-router-dom",
  () => ({
    __esModule: true,
    useLocation: () => mockLocation,
    useNavigate: () => mockNavigate,
    Link: ({ to, children, ...rest }) => {
      const href = typeof to === "string" ? to : to?.pathname || "#";
      return (
        <a href={href} {...rest}>
          {children}
        </a>
      );
    },
  }),
  { virtual: true }
);

jest.mock("../lib/homeSectionData", () => ({
  HOME_SECTION_DATA_KEYS: {
    packagesList: "packagesList",
    packagesSettings: "packagesSettings",
  },
  fetchHomeSectionData: jest.fn(),
  readHomeSectionData: jest.fn(() => null),
}));

jest.mock("../lib/useHomeSectionLinkHandler", () => () => jest.fn());

jest.mock("../components/PackageDetailsModal", () => () => null);

jest.mock("../components/BookingForm", () => () => (
  <div data-testid="booking-form">Booking Form</div>
));

const ORIGINAL_ENV = { ...process.env };

describe("India booking gate UI", () => {
  beforeEach(() => {
    mockLocation = {
      pathname: "/",
      search: "",
      hash: "",
      state: null,
    };
    mockNavigate.mockReset();
    process.env = {
      ...ORIGINAL_ENV,
      SITE_MARKET: "india",
    };
    delete process.env.INDIA_BOOKING_STATUS;
    delete process.env.NEXT_PUBLIC_INDIA_BOOKING_STATUS;
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  test("renders package booking CTAs as disabled Coming Soon buttons", () => {
    const Packages = require("../components/Packages").default;

    render(
      <Packages
        initialSectionCopy={{
          heading: "Choose Your Package",
          badgeText: "Remote Sessions",
          subheading: "Select a package",
        }}
        initialPackages={[
          {
            _id: "pkg-1",
            title: "Vertex Essentials",
            price: "₹999",
            buttonText: "Book Now",
            checkedBullets: ["Remote tuning"],
            uncheckedBullets: [],
          },
        ]}
      />
    );

    const cta = screen.getByRole("button", { name: /coming soon/i });
    expect(cta).toBeDisabled();
    expect(
      screen.queryByRole("link", { name: /book now/i })
    ).not.toBeInTheDocument();
  });

  test("blocks direct booking route with coming soon panel", () => {
    const Book = require("../legacyPages/Book").default;

    render(<Book />);

    expect(
      screen.getByRole("heading", { name: /bookings opening soon/i })
    ).toBeInTheDocument();
    expect(screen.queryByTestId("booking-form")).not.toBeInTheDocument();
  });
});
