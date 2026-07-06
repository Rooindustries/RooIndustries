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
});
