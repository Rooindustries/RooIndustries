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

  test("builds appeal and payout email templates", () => {
    const email = loadEmail();

    const adminTemplate = email.buildTourneyAppealAdminEmail({
      sampleMode: true,
      baseUrl: "https://www.rooindustries.com",
      submitter: { name: "Captain Val" },
      appeal: {
        type: "team-appeal",
        title: "Map result dispute",
        teamName: "TBD",
        captainName: "Val",
        details: "Round evidence is attached.",
        evidenceUrl: "https://example.com/evidence",
      },
    });
    const confirmationTemplate = email.buildTourneyAppealConfirmationEmail({
      sampleMode: true,
      appeal: {
        title: "Map result dispute",
        teamName: "TBD",
        captainName: "Val",
      },
    });
    const payoutTemplate = email.buildTourneyPayoutNotificationEmail({
      sampleMode: true,
      payout: {
        displayName: "Player One",
        teamName: "TBD",
        payoutType: "mvp",
        amountUsd: 125,
        status: "ready",
        payoutEmail: "playerone@example.com",
      },
    });

    expect(adminTemplate.subject).toBe(
      "[Sample] Tourney appeal submitted: Map result dispute"
    );
    expect(adminTemplate.html).toContain("New tournament appeal");
    expect(adminTemplate.html).toContain("Sample only");
    expect(confirmationTemplate.html).toContain("Appeal received");
    expect(payoutTemplate.html).toContain("$125 USD");
    expect(payoutTemplate.subject).toContain("Ready");
  });

  test("sends appeal and payout samples only to supplied recipients", async () => {
    mockSendEmail.mockResolvedValue({
      data: { id: "email_sample" },
      error: null,
    });
    const email = loadEmail();
    const env = {
      RESEND_API_KEY: "re_test",
      FROM_EMAIL: "Tourney <tourney@rooindustries.com>",
    };

    await email.sendTourneyAppealAdminEmail({
      recipients: ["serviroo@rooindustries.com"],
      sampleMode: true,
      env,
      appeal: {
        type: "team-appeal",
        title: "Sample appeal",
        teamName: "TBD",
        details: "Appeal details.",
      },
      submitter: { name: "Sample Captain" },
    });
    await email.sendTourneyAppealConfirmationEmail({
      to: "serviroo@rooindustries.com",
      sampleMode: true,
      env,
      appeal: {
        title: "Sample appeal",
        teamName: "TBD",
      },
    });
    await email.sendTourneyPayoutNotificationEmail({
      to: ["serviroo@rooindustries.com"],
      sampleMode: true,
      env,
      payout: {
        displayName: "Sample Player",
        payoutType: "mvp",
        amountUsd: 125,
        status: "ready",
      },
    });

    expect(mockSendEmail).toHaveBeenCalledTimes(3);
    for (const call of mockSendEmail.mock.calls) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          from: "Tourney <tourney@rooindustries.com>",
          to: ["serviroo@rooindustries.com"],
          subject: expect.stringContaining("[Sample]"),
        })
      );
    }
  });
});
