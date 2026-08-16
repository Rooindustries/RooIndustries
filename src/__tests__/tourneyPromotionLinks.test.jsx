import { fireEvent, render, screen } from "@testing-library/react";

const mockTrack = jest.fn();

jest.mock("@vercel/analytics/react", () => ({
  track: (...args) => mockTrack(...args),
}));

const TourneyPromotionLinks =
  require("../../app/tourney/TourneyPromotionLinks").default;

describe("TourneyPromotionLinks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.history.replaceState({}, "", "/tourney/bracket");
    delete window.va;
    delete window.vaq;
  });

  test("tracks the Boost Your FPS CTA with its tournament surface", () => {
    render(<TourneyPromotionLinks />);

    const boostLink = screen.getByRole("link", { name: /Boost Your FPS/i });
    expect(boostLink).toHaveAttribute(
      "href",
      "https://rooindustries.com/#packages",
    );

    fireEvent.click(boostLink);

    expect(mockTrack).toHaveBeenCalledWith("tourney_cta_click", {
      campaign: "losers_day",
      cta: "boost_fps",
      surface: "bracket",
    });
    expect(window.va).toEqual(expect.any(Function));
  });

  test("tracks the giveaway CTA without changing its Discord destination", () => {
    window.history.replaceState({}, "", "/tourney/roster");
    render(<TourneyPromotionLinks />);

    const giveawayLink = screen.getByRole("link", {
      name: /Stand a Chance to Win \$1,500 in Prizes/i,
    });
    expect(giveawayLink).toHaveAttribute(
      "href",
      "https://discord.com/invite/qs5HKNyazD",
    );
    expect(giveawayLink).toHaveAttribute("target", "_blank");

    fireEvent.click(giveawayLink);

    expect(mockTrack).toHaveBeenCalledWith("tourney_cta_click", {
      campaign: "losers_day",
      cta: "giveaway",
      surface: "roster",
    });
  });

  test("never blocks navigation if analytics throws", () => {
    mockTrack.mockImplementationOnce(() => {
      throw new Error("analytics unavailable");
    });
    render(<TourneyPromotionLinks />);

    expect(() =>
      fireEvent.click(
        screen.getByRole("link", { name: /Boost Your FPS/i }),
      ),
    ).not.toThrow();
  });
});
