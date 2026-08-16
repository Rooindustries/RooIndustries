import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import TourneyFeedbackPanel from "../../app/tourney/TourneyFeedbackPanel";

const mockTourneyMutationFetch = jest.fn();

jest.mock("../../app/tourney/tourneyMutation", () => ({
  tourneyMutationFetch: (...args) => mockTourneyMutationFetch(...args),
}));

const savedFeedback = {
  id: "feedback-1",
  overallRating: 5,
  organizationRating: 4,
  communicationRating: 4,
  formatRating: 5,
  broadcastRating: null,
  returnIntent: "yes",
  feedbackText: "Share lobby details earlier.",
  createdAt: "2026-08-17T12:00:00.000Z",
};

const completeRequiredForm = () => {
  for (const name of [
    "Overall Tourney experience",
    "Organisation and match flow",
    "Communication and scheduling",
    "Matches and competitive format",
  ]) {
    fireEvent.click(within(screen.getByRole("group", { name })).getByLabelText("5"));
  }
  fireEvent.click(
    within(screen.getByRole("group", {
      name: "Would you take part in another Roo Industries Tourney?",
    })).getByLabelText("Yes")
  );
  fireEvent.change(screen.getByLabelText(/What was bad, or what should we improve/i), {
    target: { value: savedFeedback.feedbackText },
  });
};

describe("TourneyFeedbackPanel", () => {
  beforeEach(() => {
    mockTourneyMutationFetch.mockReset();
    mockTourneyMutationFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, feedback: savedFeedback }),
    });
  });

  test("collects one written response and submits it anonymously", async () => {
    render(<TourneyFeedbackPanel feedbackSlug="participants-private-link" />);
    completeRequiredForm();

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByLabelText(/Team name/i)).not.toBeInTheDocument();
    expect(screen.getByText("Anonymous. No sign-in required.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send anonymous feedback" }));

    await waitFor(() => expect(mockTourneyMutationFetch).toHaveBeenCalledTimes(1));
    const request = mockTourneyMutationFetch.mock.calls[0][1];
    expect(request.headers).toEqual({
      "Content-Type": "application/json",
      "X-Tourney-Feedback-Slug": "participants-private-link",
    });
    expect(JSON.parse(request.body)).toEqual({
      overallRating: "5",
      organizationRating: "5",
      communicationRating: "5",
      formatRating: "5",
      broadcastRating: "",
      returnIntent: "yes",
      feedbackText: savedFeedback.feedbackText,
    });
    expect(await screen.findByText("Thank you for helping us improve.")).toBeInTheDocument();
    expect(screen.getByText("feedback-1")).toBeInTheDocument();
  });

  test("keeps the deployed design preview read-only without visible preview labels", () => {
    render(<TourneyFeedbackPanel feedbackSlug="participants-private-link" previewMode />);
    completeRequiredForm();

    expect(screen.queryByText(/preview/i)).not.toBeInTheDocument();
    const previewButton = screen.getByRole("button", { name: "Send anonymous feedback" });
    fireEvent.submit(previewButton.closest("form"));
    expect(screen.getByText("Thank you for helping us improve.")).toBeInTheDocument();
    expect(screen.getByText("Anonymous feedback received. Thank you for being part of the Tourney.")).toBeInTheDocument();
    expect(mockTourneyMutationFetch).not.toHaveBeenCalled();
  });
});
