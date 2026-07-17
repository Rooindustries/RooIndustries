import React from "react";
import { render, screen } from "@testing-library/react";
import BookingModal from "../components/BookingModal";
import PackageDetailsModal from "../components/PackageDetailsModal";

describe("booking modal backdrop isolation", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn(() => ({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })),
    });
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    window.requestAnimationFrame = (callback) => {
      callback();
      return 1;
    };
    window.cancelAnimationFrame = jest.fn();
    window.scrollTo = jest.fn();
  });

  test("applies the darker modifier only to BookingModal", () => {
    render(
      <>
        <BookingModal open onClose={jest.fn()}>
          <BookingContent />
        </BookingModal>
        <PackageDetailsModal
          open
          onClose={jest.fn()}
          pkg={{ title: "Vertex Essentials", price: "$29.95" }}
        />
      </>
    );

    const bookingOverlay = document.querySelector(".booking-modal-overlay");
    const packageOverlay = Array.from(
      document.querySelectorAll(".glass-overlay")
    ).find((node) => !node.classList.contains("booking-modal-overlay"));

    expect(bookingOverlay).toHaveClass(
      "booking-modal-overlay",
      "glass-overlay",
      "low-perf-overlay"
    );
    expect(packageOverlay).toHaveClass("glass-overlay", "low-perf-overlay");
    expect(packageOverlay).not.toHaveClass("booking-modal-overlay");
  });

  test("marks excluded canonical package rows as not included", () => {
    render(
      <PackageDetailsModal
        open
        onClose={jest.fn()}
        pkg={{ title: "Vertex Essentials", price: "$29.95", features: [] }}
      />
    );

    expect(
      screen.getByRole("listitem", {
        name: "Windows system tuning: included",
      })
    ).not.toHaveClass("opacity-40");
    expect(
      screen.getByRole("listitem", {
        name: "CPU GPU RAM tuning: not included",
      })
    ).toHaveClass("opacity-40");
  });
});

function BookingContent() {
  return <div>Booking content</div>;
}
