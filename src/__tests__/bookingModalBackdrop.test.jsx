import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
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

  test("moves focus into the dialog, traps Tab, and restores focus", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open booking";
    document.body.appendChild(trigger);
    trigger.focus();
    const onClose = jest.fn();
    const { rerender } = render(
      <BookingModal open onClose={onClose}>
        <BookingFocusContent />
      </BookingModal>
    );

    const closeButton = screen.getByRole("button", { name: "Close" });
    const lastButton = screen.getByRole("button", {
      name: "Last booking action",
    });
    expect(closeButton).toHaveFocus();

    lastButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    closeButton.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(lastButton).toHaveFocus();

    rerender(
      <BookingModal open={false} onClose={onClose}>
        <BookingFocusContent />
      </BookingModal>
    );
    expect(trigger).toHaveFocus();
    trigger.remove();
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

function BookingFocusContent() {
  return (
    <>
      <button type="button">First booking action</button>
      <button type="button">Last booking action</button>
    </>
  );
}
