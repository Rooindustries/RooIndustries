import { render, screen } from "@testing-library/react";
import TourneyRosterList from "../../app/tourney/TourneyRosterList";

const basePlayer = {
  id: "player-1",
  displayName: "Player One",
  rolePlay: "Damage",
  registrationPool: "main",
  teamName: "",
  twitchUsername: "playerone",
};

describe("TourneyRosterList", () => {
  test("shows a live badge for players currently live on Twitch", () => {
    render(
      <TourneyRosterList
        players={[
          {
            ...basePlayer,
            twitchLive: true,
            twitchLiveTitle: "Tournament warmups",
          },
        ]}
      />
    );

    expect(screen.getByLabelText("Player One is live on Twitch")).toBeVisible();
    expect(screen.getByRole("link", { name: /playerone/i })).toHaveAttribute(
      "href",
      "https://www.twitch.tv/playerone"
    );
  });

  test("does not show a live badge for offline players", () => {
    render(<TourneyRosterList players={[basePlayer]} />);

    expect(
      screen.queryByLabelText("Player One is live on Twitch")
    ).not.toBeInTheDocument();
  });

  test("sorts live players above offline players in the roster", () => {
    render(
      <TourneyRosterList
        players={[
          {
            ...basePlayer,
            id: "alpha-offline",
            displayName: "Alpha Offline",
            twitchUsername: "alphaoffline",
            twitchLive: false,
          },
          {
            ...basePlayer,
            id: "zed-live",
            displayName: "Zed Live",
            twitchUsername: "zedlive",
            twitchLive: true,
          },
          {
            ...basePlayer,
            id: "beta-live",
            displayName: "Beta Live",
            twitchUsername: "betalive",
            twitchLive: true,
          },
          {
            ...basePlayer,
            id: "gamma-offline",
            displayName: "Gamma Offline",
            twitchUsername: "gammaoffline",
            twitchLive: false,
          },
        ]}
      />
    );

    expect(
      screen.getAllByRole("listitem").map((item) => item.textContent)
    ).toEqual([
      expect.stringContaining("Beta Live"),
      expect.stringContaining("Zed Live"),
      expect.stringContaining("Alpha Offline"),
      expect.stringContaining("Gamma Offline"),
    ]);
  });
});
