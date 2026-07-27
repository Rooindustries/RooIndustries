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

  test("shows captains in the standard roster row with Twitch identity and avatar", () => {
    const profileImageUrl =
      "https://static-cdn.jtvnw.net/jtv_user_pictures/skinzow-profile_image-300x300.png";
    const { container } = render(
      <TourneyRosterList
        players={[
          {
            ...basePlayer,
            isCaptain: true,
            twitchUsername: "twitch.tv/skinzow",
            twitchProfileImageUrl: profileImageUrl,
          },
        ]}
      />
    );

    expect(screen.getByText("Team Captain")).toBeVisible();
    expect(screen.queryByText("Player", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /skinzow/i })).toHaveAttribute(
      "href",
      "https://www.twitch.tv/skinzow"
    );
    expect(container.querySelector(".tourney-roster-player")).toHaveClass(
      "is-captain"
    );
    expect(container.querySelector(".tourney-roster-avatar img")).toHaveAttribute(
      "src",
      profileImageUrl
    );
  });

  test("shows only the substitute pool for substitute-only input", () => {
    render(
      <TourneyRosterList
        players={[
          {
            ...basePlayer,
            id: "substitute-1",
            displayName: "SimplyXero",
            registrationPool: "substitute",
            twitchUsername: "simplyxero",
          },
        ]}
      />
    );

    expect(screen.getByText("Substitute Pool")).toBeVisible();
    expect(screen.queryByText("Main Pool")).not.toBeInTheDocument();
    expect(screen.getByText("SimplyXero")).toBeVisible();
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
