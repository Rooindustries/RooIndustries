import { render, screen } from "@testing-library/react";
import TourneyTeamCards from "../../app/tourney/TourneyTeamCards";

const captains = Array.from({ length: 12 }, (_, index) => {
  const captainSeed = index + 1;
  return {
    id: `captain-${captainSeed}`,
    captainSeed,
    displayName: `Captain ${captainSeed}`,
    rolePlay: captainSeed % 2 ? "Damage" : "Support",
    twitchUsername: `captain${captainSeed}`,
    twitchProfileImageUrl: `https://static-cdn.jtvnw.net/captain-${captainSeed}.png`,
    ...(captainSeed === 1
      ? {
          twitchLive: true,
          twitchLiveTitle: "Captain 1 live stream",
        }
      : {}),
  };
});

describe("TourneyTeamCards", () => {
  test("renders teams one through twelve in two six-team groups", () => {
    render(<TourneyTeamCards players={captains} />);

    expect(
      screen.getByRole("heading", { name: "Teams 1–6" })
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Teams 7–12" })
    ).toBeVisible();
    for (let teamNumber = 1; teamNumber <= 12; teamNumber += 1) {
      expect(
        screen.getByRole("heading", { name: `Team ${teamNumber}` })
      ).toBeVisible();
    }
  });

  test("puts each captain first and leaves six pending draft slots per team", () => {
    const { container } = render(<TourneyTeamCards players={captains} />);

    expect(container.querySelectorAll(".tourney-team-slot.is-captain")).toHaveLength(
      12
    );
    expect(screen.getAllByText("Pending")).toHaveLength(72);
    expect(screen.getAllByText(/Team Captain ·/)).toHaveLength(12);
    expect(screen.getByRole("link", { name: "captain1" })).toHaveAttribute(
      "href",
      "https://www.twitch.tv/captain1"
    );
    expect(
      container.querySelector(".tourney-team-slot-avatar img")
    ).toHaveAttribute(
      "src",
      "https://static-cdn.jtvnw.net/captain-1.png"
    );
  });

  test("shows the established live badge on a live captain slot", () => {
    const { container } = render(<TourneyTeamCards players={captains} />);

    expect(
      screen.getByLabelText("Captain 1 is live on Twitch")
    ).toHaveAttribute("title", "Captain 1 live stream");
    expect(
      container.querySelectorAll(".tourney-team-slot.is-captain.is-live")
    ).toHaveLength(1);
    expect(screen.getAllByText("Live")).toHaveLength(1);
    expect(
      screen.queryByLabelText("Captain 2 is live on Twitch")
    ).not.toBeInTheDocument();
  });
});
