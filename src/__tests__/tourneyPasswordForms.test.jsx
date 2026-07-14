import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockTourneyMutationFetch = jest.fn();

jest.mock("../../app/tourney/tourneyMutation", () => ({
  tourneyMutationFetch: (...args) => mockTourneyMutationFetch(...args),
  tourneyMutationSuccessMessage: (data, message) =>
    data?.syncPending ? `${message} Synchronization is completing in the background.` : message,
}));

const {
  TourneyForgotForm,
  TourneyResetForm,
} = require("../../app/tourney/TourneyPasswordForms");

const submitForgotForm = () => {
  fireEvent.change(screen.getByLabelText("Discord username or email"), {
    target: { value: "player@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send reset link" }));
};

const submitResetForm = () => {
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "updated-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Update password" }));
};

describe("Tourney forgot-password form", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders successful reset requests as a status message", async () => {
    mockTourneyMutationFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        message: "If that account exists, a reset link was sent.",
      }),
    });
    render(<TourneyForgotForm />);

    submitForgotForm();

    const message = await screen.findByRole("status");
    expect(message.className).toContain("is-success");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("renders failed reset requests as an alert without success styling", async () => {
    mockTourneyMutationFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        error: "Tournament updates are briefly paused. Try again shortly.",
      }),
    });
    render(<TourneyForgotForm />);

    submitForgotForm();

    const message = await screen.findByRole("alert");
    await waitFor(() => {
      expect(message.textContent).toContain("briefly paused");
    });
    expect(message.className).not.toContain("is-success");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Tourney reset-password form", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.location.hash = "#token=reset-token";
  });

  test("renders successful password resets as a status message", async () => {
    mockTourneyMutationFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, message: "Password updated." }),
    });
    render(<TourneyResetForm />);

    submitResetForm();

    const message = await screen.findByRole("status");
    expect(message.className).toContain("is-success");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("renders failed password resets as an alert without success styling", async () => {
    mockTourneyMutationFetch.mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({
        ok: false,
        error: "Tournament updates are briefly paused. Try again shortly.",
      }),
    });
    render(<TourneyResetForm />);

    submitResetForm();

    const message = await screen.findByRole("alert");
    await waitFor(() => {
      expect(message.textContent).toContain("briefly paused");
    });
    expect(message.className).not.toContain("is-success");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
