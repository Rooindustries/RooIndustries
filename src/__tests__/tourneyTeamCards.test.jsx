import { render, screen, within } from "@testing-library/react";
import TourneyTeamCards from "../../app/tourney/TourneyTeamCards";

const teamNames = [
  "Team WSPS",
  "Team Cookies",
  "Team TapNoCap",
  "Team Wolfi",
  "Team Chosen",
  "Team HerLoaf",
  "Team Putter",
  "Team HMP",
  "Team Cheesnut",
  "Team MintThief",
  "Team R3ntzu",
  "Team Skinz",
];

const captains = teamNames.map((teamName, index) => {
  const captainSeed = index + 1;
  return {
    id: `captain-${captainSeed}`,
    captainSeed,
    displayName: `Captain ${captainSeed}`,
    rolePlay: captainSeed % 2 ? "Damage" : "Support",
    teamName,
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

const teammateRoles = ["Tank", "Tank", "Damage", "Damage", "Support", "Flex"];
const teammates = teamNames.flatMap((teamName, teamIndex) =>
  teammateRoles.map((rolePlay, playerIndex) => ({
    id: `team-${teamIndex + 1}-player-${playerIndex + 1}`,
    displayName: `Team ${teamIndex + 1} Player ${playerIndex + 1}`,
    rolePlay,
    teamName,
    twitchUsername: `team${teamIndex + 1}player${playerIndex + 1}`,
    ...(teamIndex === 0 && playerIndex === 0
      ? {
          twitchProfileImageUrl:
            "https://static-cdn.jtvnw.net/team-1-player-1.png",
        }
      : {}),
  }))
);
const allocatedPlayers = [...captains, ...teammates];

describe("TourneyTeamCards", () => {
  test("renders the twelve named teams in two six-team groups", () => {
    render(<TourneyTeamCards players={allocatedPlayers} />);

    expect(screen.getByRole("heading", { name: "Teams 1–6" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Teams 7–12" })).toBeVisible();
    for (const teamName of teamNames) {
      expect(screen.getByRole("heading", { name: teamName })).toBeVisible();
    }
  });

  test("fills every roster with its captain first and six assigned players", () => {
    const { container } = render(
      <TourneyTeamCards players={allocatedPlayers} />
    );

    expect(container.querySelectorAll(".tourney-team-slot")).toHaveLength(84);
    expect(
      container.querySelectorAll(".tourney-team-slot.is-captain")
    ).toHaveLength(12);
    expect(
      container.querySelectorAll(".tourney-team-slot.is-player")
    ).toHaveLength(72);
    expect(screen.queryByText("Pending")).not.toBeInTheDocument();
    expect(screen.getAllByText(/Team Captain ·/)).toHaveLength(12);
    expect(screen.getAllByText(/Roster Player ·/)).toHaveLength(72);

    const firstTeamCard = screen
      .getByRole("heading", { name: "Team WSPS" })
      .closest("article");
    const firstTeamSlots = within(firstTeamCard).getAllByRole("listitem");
    expect(firstTeamSlots).toHaveLength(7);
    expect(firstTeamSlots[0]).toHaveTextContent("Captain 1");
    expect(firstTeamSlots[1]).toHaveTextContent("Team 1 Player 1");
    expect(within(firstTeamCard).getByText("Team 1 Player 6")).toBeVisible();
    expect(within(firstTeamCard).getByRole("link", { name: "captain1" })).toHaveAttribute(
      "href",
      "https://www.twitch.tv/captain1"
    );
    expect(
      firstTeamCard.querySelector('.tourney-team-slot.is-player img')
    ).toHaveAttribute(
      "src",
      "https://static-cdn.jtvnw.net/team-1-player-1.png"
    );
  });

  test("shows the established live badge on a live captain slot", () => {
    const { container } = render(
      <TourneyTeamCards players={allocatedPlayers} />
    );

    expect(screen.getByLabelText("Captain 1 is live on Twitch")).toHaveAttribute(
      "title",
      "Captain 1 live stream"
    );
    expect(
      container.querySelectorAll(".tourney-team-slot.is-captain.is-live")
    ).toHaveLength(1);
    expect(screen.getAllByText("Live")).toHaveLength(1);
    expect(
      screen.queryByLabelText("Captain 2 is live on Twitch")
    ).not.toBeInTheDocument();
  });

  test("keeps pending slots as a fallback for incomplete rosters", () => {
    render(<TourneyTeamCards players={captains} />);

    expect(screen.getAllByText("Pending")).toHaveLength(72);
  });
});
