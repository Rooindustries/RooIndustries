const mockSendEmail = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn(() => ({
    emails: {
      send: mockSendEmail,
    },
  })),
}));

const loadEmail = () => {
  jest.resetModules();
  return require("../server/tourney/email.js");
};

describe("tourney emails", () => {
  afterEach(() => {
    mockSendEmail.mockReset();
    jest.resetModules();
  });

  test("sends approval notifications to the approved player", async () => {
    mockSendEmail.mockResolvedValue({
      data: { id: "email_player_approved" },
      error: null,
    });
    const email = loadEmail();

    await expect(
      email.sendTourneyPlayerApprovedEmail({
        player: {
          email: "playerone@example.com",
          discord: "PlayerOne#1234",
        },
        baseUrl: "https://www.rooindustries.com",
        env: {
          RESEND_API_KEY: "re_test",
          FROM_EMAIL: "Tourney <tourney@rooindustries.com>",
        },
      })
    ).resolves.toEqual({ id: "email_player_approved" });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Tourney <tourney@rooindustries.com>",
        to: ["playerone@example.com"],
        subject: expect.stringMatching(/approved/i),
        html: expect.stringContaining(
          "https://www.rooindustries.com/tourney/login"
        ),
      })
    );
    expect(mockSendEmail.mock.calls[0][0].html).toContain("PlayerOne#1234");
  });
});
