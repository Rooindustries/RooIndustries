import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RefDashboard from "../components/RefDashboard";

const mockNavigate = jest.fn();

jest.mock(
  "react-router-dom",
  () => ({
    __esModule: true,
    useLocation: () => ({ search: window.location.search }),
    useNavigate: () => mockNavigate,
  }),
  { virtual: true }
);

const referralPayload = {
  ok: true,
  referral: {
    name: "Creator",
    slug: { current: "creator-code" },
    successfulReferrals: 6,
    currentCommissionPercent: 10,
    currentDiscountPercent: 5,
    maxCommissionPercent: 15,
  },
};

const payoutPayload = {
  ok: true,
  earnings: {
    xoc: 60,
    vertex: 40,
    total: 100,
    byPackage: {
      "XOC / Extreme Overclocking": 60,
      "Performance Vertex Overhaul": 40,
    },
  },
  packageBreakdown: [
    { title: "XOC / Extreme Overclocking", amount: 60 },
    { title: "Performance Vertex Overhaul", amount: 40 },
  ],
  payments: {
    xoc: 30,
    vertex: 40,
    total: 70,
  },
  remaining: {
    xoc: 30,
    vertex: 0,
    total: 30,
  },
  owed: {
    xoc: 30,
    vertex: 0,
    total: 30,
  },
  overpaid: {
    xoc: 0,
    vertex: 0,
    total: 0,
  },
  logs: {
    xoc: [{ _key: "x1", amount: 30, paidOn: "2026-05-01T00:00:00.000Z" }],
    vertex: [{ _key: "v1", amount: 40, paidOn: "2026-05-02T00:00:00.000Z" }],
  },
};

describe("RefDashboard payout summary", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
    window.history.replaceState(null, "", "/referrals/dashboard");
    global.fetch = jest.fn(async (url) => {
      if (url === "/api/ref/getData") {
        return { ok: true, json: async () => referralPayload };
      }

      if (url === "/api/ref/payouts") {
        return { ok: true, json: async () => payoutPayload };
      }

      return { ok: true, json: async () => ({ ok: true }) };
    });
  });

  afterEach(() => {
    if (global.fetch && global.fetch.mockReset) {
      global.fetch.mockReset();
    }
  });

  test("shows earned, paid, and remaining owed without labeling package earnings as owed", async () => {
    render(<RefDashboard />);

    expect(await screen.findByText("Remaining owed")).toBeInTheDocument();
    expect(screen.getByText("Total earned")).toBeInTheDocument();
    expect(screen.getByText("Total paid")).toBeInTheDocument();
    expect(screen.getByText("Package earnings")).toBeInTheDocument();
    expect(screen.getByText("Earned - Performance Vertex Max")).toBeInTheDocument();
    expect(
      screen.getByText("Earned - Performance Vertex Overhaul")
    ).toBeInTheDocument();
    expect(screen.getByText("$70.00")).toBeInTheDocument();
    expect(screen.getAllByText("$30.00").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Total owed -/i)).not.toBeInTheDocument();
  });

  test("shows referral links without the packages anchor", async () => {
    render(<RefDashboard />);

    const referralInput = await screen.findByDisplayValue(
      `${window.location.origin}/?ref=creator-code`
    );

    expect(referralInput.value).not.toContain("#packages");
  });

  test("keeps Discord link success visible after the dashboard loads", async () => {
    window.history.replaceState(
      null,
      "",
      "/referrals/dashboard?notice=discord-linked"
    );

    render(<RefDashboard />);

    expect(
      await screen.findByText("Discord linked to your account.")
    ).toBeInTheDocument();
  });

  test("keeps a failed Discord link explicit after login reaches the dashboard", async () => {
    window.history.replaceState(
      null,
      "",
      "/referrals/dashboard?notice=discord-link-failed"
    );

    render(<RefDashboard />);

    expect(
      await screen.findByText(
        "Discord linking did not complete. Try the Discord login again."
      )
    ).toBeInTheDocument();
  });

  test("exposes payment logs as a modal dialog and closes it with Escape", async () => {
    render(<RefDashboard />);

    fireEvent.click(
      await screen.findByRole("button", { name: "View my payment logs" })
    );

    const dialog = screen.getByRole("dialog", { name: "Payment Logs" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Payment Logs" })
      ).not.toBeInTheDocument();
    });
  });
});
