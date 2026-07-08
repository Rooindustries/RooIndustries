import { render, screen } from "@testing-library/react";
import {
  TourneyHosts,
  TourneyRosterHosts,
  tourneyHosts,
} from "../../app/tourney/TourneyShared";

jest.mock("next/headers", () => ({
  cookies: jest.fn(async () => ({ get: () => undefined })),
}));

jest.mock("../../src/server/tourney/access", () => ({
  isTourneyAdminSession: jest.fn(() => false),
}));

const withLiveHost = (name) =>
  tourneyHosts.map((host) =>
    host.name === name
      ? {
          ...host,
          twitchLive: true,
          twitchLiveTitle: "Tournament stream",
        }
      : host
  );

describe("tourney host live status", () => {
  test("shows a Twitch live badge on public host cards", () => {
    render(<TourneyHosts hosts={withLiveHost("Yukari")} />);

    expect(screen.getByLabelText("Yukari is live on Twitch")).toBeVisible();
    expect(screen.getByRole("link", { name: /yukaripoi/i })).toHaveAttribute(
      "href",
      "https://www.twitch.tv/yukaripoi"
    );
  });

  test("keeps roster host order fixed even when a later host is live", () => {
    render(<TourneyRosterHosts hosts={withLiveHost("Supa")} />);

    const hostNames = screen.getAllByRole("listitem").map((item) =>
      item.querySelector(".tourney-roster-player-name")?.textContent?.trim()
    );

    expect(hostNames).toEqual(["Serviroo", "Yukari", "Supa"]);
    expect(screen.getByLabelText("Supa is live on Twitch")).toBeVisible();
  });
});
