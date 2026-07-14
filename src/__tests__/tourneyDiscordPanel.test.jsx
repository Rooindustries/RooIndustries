import { render, screen } from "@testing-library/react";
import TourneyDiscordPanel from "../../app/tourney/TourneyDiscordPanel";

jest.mock("../components/SupabaseSocialLogin", () =>
  function MockSupabaseSocialLogin({ action, reauthPurpose }) {
    return (
      <button
        data-action={action}
        data-reauth-purpose={reauthPurpose}
        type="button"
      >
        Connect Discord
      </button>
    );
  }
);
jest.mock("../components/ConnectedAccounts", () =>
  function MockConnectedAccounts({ providerIds }) {
    return (
      <button data-providers={providerIds.join(",")} type="button">
        Confirm identity to link Discord
      </button>
    );
  }
);

const statusResponse = (
  state,
  linked = true,
  roleAssigned = state === "applied"
) => ({
  ok: true,
  json: async () => ({
    ok: true,
    discord: { linked, roleAssigned, state },
  }),
});

describe("Tourney Discord role status", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("does not treat a linked pending role as applied", async () => {
    global.fetch.mockResolvedValue(statusResponse("pending"));
    render(<TourneyDiscordPanel signedIn />);

    expect(await screen.findByText(
      "Discord is linked. Your tournament role is pending."
    )).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: "Connect Discord" })).not.toBeInTheDocument();
  });

  test("offers fresh OAuth when membership is blocked", async () => {
    global.fetch.mockResolvedValue(statusResponse("blocked_reauth"));
    render(<TourneyDiscordPanel signedIn />);

    expect(await screen.findByText(
      "Reconnect Discord so Roo Industries can restore your tournament role."
    )).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: "Connect Discord" })).toHaveAttribute(
      "data-action",
      "reauth"
    );
    expect(screen.getByRole("button", { name: "Connect Discord" })).toHaveAttribute(
      "data-reauth-purpose",
      "link_identity"
    );
  });

  test("uses account linking only for an unlinked Discord identity", async () => {
    global.fetch.mockResolvedValue(statusResponse("unlinked", false));
    render(<TourneyDiscordPanel signedIn />);

    expect(await screen.findByText(
      "Connect the Discord account you will use for the tournament."
    )).toHaveAttribute("role", "status");
    expect(
      screen.getByRole("button", { name: "Confirm identity to link Discord" })
    ).toHaveAttribute("data-providers", "discord");
  });

  test("does not trust an applied state without the durable role flag", async () => {
    global.fetch.mockResolvedValue(statusResponse("applied", true, false));
    render(<TourneyDiscordPanel signedIn />);

    expect(await screen.findByText(
      "Discord is linked. Your tournament role is pending."
    )).toHaveAttribute("role", "status");
    expect(screen.queryByText(
      "Discord is linked and your tournament role is applied."
    )).not.toBeInTheDocument();
  });

  test("reports an applied role as ready", async () => {
    global.fetch.mockResolvedValue(statusResponse("applied"));
    render(<TourneyDiscordPanel signedIn />);

    expect(await screen.findByText(
      "Discord is linked and your tournament role is applied."
    )).toHaveAttribute("role", "status");
    expect(screen.queryByRole("button", { name: "Connect Discord" })).not.toBeInTheDocument();
  });
});
