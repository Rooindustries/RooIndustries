import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TourneyRegistrationForm from "../../app/tourney/TourneyRegistrationForm";

const renderRegistrationForm = async () => {
  render(
    <TourneyRegistrationForm registrationClosesAt="2026-07-22T00:00:00.000Z" />
  );

  const primaryRole = await screen.findByLabelText("Primary Role");
  const secondaryRole = screen.getByLabelText("Secondary Role");

  return { primaryRole, secondaryRole };
};

const creatorEligibilityLabel =
  "I understand this is a creator tournament and my Twitch username will be used for eligibility review.";

describe("TourneyRegistrationForm support warning", () => {
  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        message: "Registration submitted.",
      }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("warns when Support is selected as the primary role", async () => {
    const { primaryRole } = await renderRegistrationForm();

    await userEvent.selectOptions(primaryRole, "Support");

    expect(
      await screen.findByRole("dialog", {
        name: "Support signups are crowded",
      })
    ).toBeVisible();
  });

  test("warns when Support is selected as the secondary role", async () => {
    const { primaryRole, secondaryRole } = await renderRegistrationForm();

    await userEvent.selectOptions(primaryRole, "Damage");
    await userEvent.selectOptions(secondaryRole, "Support");

    expect(
      await screen.findByRole("dialog", {
        name: "Support signups are crowded",
      })
    ).toBeVisible();
  });

  test("Apply anyway keeps the Support selection", async () => {
    const { primaryRole } = await renderRegistrationForm();

    await userEvent.selectOptions(primaryRole, "Support");
    await userEvent.click(
      await screen.findByRole("button", { name: "Apply anyway" })
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(primaryRole).toHaveValue("Support");
  });

  test("Change role clears the Support selection and returns focus", async () => {
    const { primaryRole, secondaryRole } = await renderRegistrationForm();

    await userEvent.selectOptions(primaryRole, "Damage");
    await userEvent.selectOptions(secondaryRole, "Support");
    await userEvent.click(
      await screen.findByRole("button", { name: "Change role" })
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(secondaryRole).toHaveValue("");
    expect(secondaryRole).toHaveFocus();
  });

  test("requires creator eligibility acknowledgement", async () => {
    await renderRegistrationForm();

    expect(screen.getByLabelText(creatorEligibilityLabel)).toBeRequired();
  });

  test("submits creator eligibility acknowledgement in the payload", async () => {
    const { primaryRole } = await renderRegistrationForm();

    await userEvent.type(screen.getByLabelText("Discord Username"), "PlayerOne#1234");
    await userEvent.type(screen.getByLabelText("Display Name"), "Player One");
    await userEvent.type(screen.getByLabelText("Email"), "player@example.com");
    await userEvent.type(screen.getByLabelText("Password"), "player-password");
    await userEvent.type(
      screen.getByLabelText("Confirm password"),
      "player-password"
    );
    await userEvent.type(
      screen.getByLabelText("Battle.net BattleTag"),
      "Player#1234"
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Current Overwatch rank"),
      "Master"
    );
    await userEvent.selectOptions(primaryRole, "Damage");
    await userEvent.selectOptions(
      screen.getByLabelText("Timezone"),
      "Eastern Time (ET)"
    );
    await userEvent.type(screen.getByPlaceholderText("skinz_ow"), "playerone");
    await userEvent.click(
      screen.getByLabelText("Are you free on August 15th and 16th?")
    );
    await userEvent.click(
      screen.getByLabelText("I have read the tournament rules and agree to follow them.")
    );
    await userEvent.click(screen.getByLabelText(creatorEligibilityLabel));
    await userEvent.click(
      screen.getByLabelText(
        /I understand the event stream or Discord may include a small pinned/i
      )
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Submit registration" })
    );

    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    const [, options] = global.fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({
      acceptedCreatorEligibility: true,
      twitchUsername: "playerone",
    });
  });
});
