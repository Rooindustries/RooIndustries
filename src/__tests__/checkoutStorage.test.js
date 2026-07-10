import {
  persistBookingPackageSelection,
  readBookingPackageSelection,
} from "../lib/checkoutStorage";

describe("tab-scoped booking package state", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test("persists package selection without using a URL payload", () => {
    const selected = persistBookingPackageSelection({
      title: "Performance Vertex Max",
      price: "$99.95",
      tag: "For Enthusiasts & Pros",
    });

    expect(selected).toEqual({
      title: "Performance Vertex Max",
      price: "$99.95",
      tag: "For Enthusiasts & Pros",
    });
    expect(readBookingPackageSelection()).toEqual(selected);
  });

  test("preserves an existing form draft for the selected package", () => {
    window.sessionStorage.setItem(
      "booking_draft",
      JSON.stringify({
        lastTitle: "Performance Vertex Max",
        packages: {
          "Performance Vertex Max": {
            form: { email: "customer@example.com" },
          },
        },
      })
    );

    persistBookingPackageSelection({
      title: "Performance Vertex Max",
      price: "$99.95",
    });

    const stored = JSON.parse(window.sessionStorage.getItem("booking_draft"));
    expect(stored.packages["Performance Vertex Max"].form).toEqual({
      email: "customer@example.com",
    });
  });
});
