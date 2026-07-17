import fs from "node:fs";
import path from "node:path";
import React, { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import RootLayout from "../../app/layout";
import Benchmarks from "../components/Benchmarks";
import Contact from "../components/Contact";
import ImageZoomModal from "../components/ImageZoomModal";
import MoreReviews from "../components/MoreReviews";
import Navbar from "../components/Navbar";
import Packages from "../components/Packages";
import Tools from "../components/Tools";
import { getPublicContent } from "../lib/publicContentClient";

jest.mock("@formspree/react", () => ({
  ValidationError: () => null,
  useForm: () => [
    { errors: [], submitting: false, succeeded: false },
    jest.fn(),
  ],
}));

jest.mock("../lib/publicContentClient", () => ({
  getPublicContent: jest.fn(),
}));

jest.mock("../sanityClient", () => ({
  urlFor: jest.fn((image) => {
    const builder = {
      format: () => builder,
      quality: () => builder,
      url: () => image?.url || "https://assets.example.test/image.webp",
      width: () => builder,
    };
    return builder;
  }),
}));

jest.mock("../components/BackButton", () => () => null);
jest.mock("../components/DiscordGuideBanner", () => () => null);

const image = (name) => ({
  dimensions: { height: 720, width: 1280 },
  url: `https://assets.example.test/${name}.png`,
});

describe("UI accessibility regressions", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getPublicContent.mockResolvedValue([]);
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn((query) => ({
        matches: query === "(min-width: 768px)",
        media: query,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
      })),
    });
    global.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
    window.cancelAnimationFrame = jest.fn();
    window.scrollTo = jest.fn();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("reports clipboard rejection without claiming the email was copied", async () => {
    const writeText = jest.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    getPublicContent.mockResolvedValue({
      email: "support@example.test",
      subtitle: "Example contact subtitle",
      title: "Example contact",
    });

    render(<Contact />);
    await screen.findByText("support@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(
      await screen.findByText(
        "Copy failed. Select the email address and copy it manually."
      )
    ).toHaveAttribute("role", "status");
    expect(writeText).toHaveBeenCalledWith("support@example.test");
    expect(screen.queryByRole("button", { name: "Copied!" })).toBeNull();
  });

  test("shows copied state only after the clipboard write resolves", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    getPublicContent.mockResolvedValue({ email: "support@example.test" });

    render(<Contact />);
    await screen.findByText("support@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    expect(
      await screen.findByRole("button", { name: "Copied!" })
    ).toBeVisible();
  });

  test("opens benchmark zoom from a native button", async () => {
    getPublicContent.mockResolvedValue([
      {
        _id: "benchmark-example",
        title: "Example system",
        beforeImage: image("before"),
        afterImage: image("after"),
      },
    ]);

    render(<Benchmarks />);
    const openButton = await screen.findByRole("button", {
      name: "Open Example system benchmark before optimization",
    });

    fireEvent.click(openButton);
    expect(
      screen.getByRole("dialog", {
        name: "Image preview: Example system benchmark before optimization",
      })
    ).toHaveAttribute("aria-modal", "true");
  });

  test("opens a community review zoom from a native button", async () => {
    getPublicContent.mockResolvedValue([
      {
        _id: "review-example",
        alt: "Example client review",
        image: image("review"),
      },
    ]);

    render(<MoreReviews />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Open Example client review",
      })
    );

    expect(
      screen.getByRole("dialog", {
        name: "Image preview: Example client review",
      })
    ).toBeVisible();
  });

  test("traps image dialog focus and restores the trigger on Escape", async () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open preview";
    document.body.appendChild(trigger);
    trigger.focus();

    function ModalHarness() {
      const [open, setOpen] = useState(true);
      return open ? (
        <ImageZoomModal
          src="https://assets.example.test/preview.png"
          alt="Example preview"
          onClose={() => setOpen(false)}
        />
      ) : null;
    }

    render(<ModalHarness />);
    const closeButton = screen.getByRole("button", {
      name: "Close image preview",
    });
    expect(closeButton).toHaveFocus();

    const zoomInButton = screen.getByRole("button", { name: "Zoom in" });
    zoomInButton.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(closeButton).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(trigger).toHaveFocus();
    trigger.remove();
  });

  test("closes the download dialog with Escape and restores focus", async () => {
    getPublicContent.mockResolvedValue([
      {
        _id: "tool-example",
        title: "Example utility",
        downloadMode: "official",
        downloadUrl: "https://downloads.example.test/utility",
      },
    ]);

    render(<Tools />);
    const downloadButton = await screen.findByRole("button", {
      name: "Download",
    });
    downloadButton.focus();
    fireEvent.click(downloadButton);

    const dialog = screen.getByRole("dialog", { name: "Example utility" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(downloadButton).toHaveFocus();
  });

  test("uses a legible text token for excluded package rows", () => {
    render(
      <MemoryRouter>
        <Packages
          initialPackages={[
            {
              _id: "package-example",
              title: "Standard plan",
              price: "$20",
              checkedBullets: ["Core tuning"],
              uncheckedBullets: ["Extended support"],
            },
          ]}
          initialSectionCopy={{ heading: "Example plans" }}
        />
      </MemoryRouter>
    );

    const excludedRow = screen.getByText("Extended support").closest("li");
    expect(excludedRow).toHaveClass(
      "ri-package-bullet-excluded",
      "text-ink-muted"
    );
    expect(excludedRow).not.toHaveClass("opacity-35");
  });

  test("uses disclosure semantics and closes desktop dropdowns from the keyboard", () => {
    render(
      <MemoryRouter>
        <Navbar />
      </MemoryRouter>
    );

    const proofButton = screen
      .getAllByRole("button", { name: "Proof" })
      .find((button) => button.getAttribute("aria-controls") === "desktop-proof-menu");
    expect(proofButton).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(proofButton);
    expect(proofButton).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("desktop-proof-menu")).toBeVisible();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(proofButton).toHaveAttribute("aria-expanded", "false");
    expect(proofButton).toHaveFocus();

    const referralsButton = screen
      .getAllByRole("button", { name: "Referrals" })
      .find(
        (button) =>
          button.getAttribute("aria-controls") === "desktop-referrals-menu"
      );
    expect(referralsButton).not.toHaveAttribute("aria-haspopup");
    fireEvent.click(referralsButton);
    const referralsPanel = document.getElementById("desktop-referrals-menu");
    const dashboardLink = within(referralsPanel).getByRole("link", {
      name: "Dashboard",
    });
    const outsideButton = document.createElement("button");
    document.body.appendChild(outsideButton);
    act(() => dashboardLink.focus());
    fireEvent.blur(dashboardLink, { relatedTarget: outsideButton });

    expect(referralsButton).toHaveAttribute("aria-expanded", "false");
    outsideButton.remove();
  });

  test("renders a global skip link with a focusable main target", () => {
    const layout = RootLayout({ children: <div>Example page</div> });
    const body = React.Children.toArray(layout.props.children).find(
      (child) => child.type === "body"
    );
    const skipLink = React.Children.toArray(body.props.children).find(
      (child) => child.props?.className === "skip-to-content"
    );
    const appSource = fs.readFileSync(
      path.join(process.cwd(), "src", "App.jsx"),
      "utf8"
    );

    expect(skipLink.props.href).toBe("#main-content");
    expect(skipLink.props.children).toBe("Skip to content");
    expect(appSource).toContain('id="main-content"');
    expect(appSource).toContain("tabIndex={-1}");
  });
});
