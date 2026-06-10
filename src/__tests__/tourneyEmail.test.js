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
          id: "player_1",
          version: "2",
          email: "playerone@example.com",
          discord: "PlayerOne#1234",
        },
        baseUrl: "https://www.rooindustries.com",
        env: {
          NODE_ENV: "test",
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

  test("includes Discord invite links in approved player emails when configured", async () => {
    mockSendEmail.mockResolvedValue({
      data: { id: "email_player_approved" },
      error: null,
    });
    const email = loadEmail();

    await email.sendTourneyPlayerApprovedEmail({
      player: {
        id: "player_1",
        version: "2",
        email: "playerone@example.com",
        discord: "PlayerOne#1234",
      },
      baseUrl: "https://www.rooindustries.com",
      env: {
        RESEND_API_KEY: "re_test",
        FROM_EMAIL: "Tourney <tourney@rooindustries.com>",
        TOURNEY_SESSION_SECRET: "test-secret",
        TOURNEY_DISCORD_INVITE_URL: "https://discord.gg/tourney",
      },
    });

    expect(mockSendEmail.mock.calls[0][0].html).toContain(
      "https://discord.gg/tourney"
    );
    expect(mockSendEmail.mock.calls[0][0].text).toContain(
      "Join Roo Industries Discord"
    );
  });

  test("uses the verified Discord start route when OAuth is configured", async () => {
    mockSendEmail.mockResolvedValue({
      data: { id: "email_player_approved" },
      error: null,
    });
    const email = loadEmail();

    await email.sendTourneyPlayerApprovedEmail({
      player: {
        id: "player_1",
        version: "2",
        email: "playerone@example.com",
        discord: "PlayerOne#1234",
      },
      baseUrl: "https://www.rooindustries.com",
      env: {
        RESEND_API_KEY: "re_test",
        FROM_EMAIL: "Tourney <tourney@rooindustries.com>",
        TOURNEY_SESSION_SECRET: "test-secret",
        TOURNEY_DISCORD_INVITE_URL: "https://discord.gg/tourney",
        DISCORD_CLIENT_ID: "client_1",
        DISCORD_CLIENT_SECRET: "secret_1",
        DISCORD_BOT_TOKEN: "bot_1",
        DISCORD_GUILD_ID: "guild_1",
        DISCORD_PARTICIPANT_ROLE_ID: "role_1",
      },
    });

    const html = mockSendEmail.mock.calls[0][0].html;
    expect(html).toContain("/api/tourney/discord/start?token=");
    expect(mockSendEmail.mock.calls[0][0].text).toContain(
      "Join or verify Discord for the Participant role"
    );
  });

  test("sends sample Discord invite emails only to the supplied sample recipient", async () => {
    mockSendEmail.mockResolvedValue({
      data: { id: "email_sample_discord" },
      error: null,
    });
    const email = loadEmail();

    await expect(
      email.sendTourneyDiscordInviteEmail({
        to: "serviroo@rooindustries.com",
        sampleMode: true,
        baseUrl: "https://www.rooindustries.com",
        env: {
          RESEND_API_KEY: "re_test",
          FROM_EMAIL: "Tourney <tourney@rooindustries.com>",
          TOURNEY_DISCORD_INVITE_URL: "https://discord.gg/tourney",
        },
        player: {
          email: "playerone@example.com",
          discord: "PlayerOne#1234",
          displayName: "Player One",
        },
      })
    ).resolves.toEqual({ id: "email_sample_discord" });

    expect(mockSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "Tourney <tourney@rooindustries.com>",
        to: ["serviroo@rooindustries.com"],
        subject: "[Sample] Roo Industries Discord invite",
        html: expect.stringContaining("Sample only"),
      })
    );
    expect(JSON.stringify(mockSendEmail.mock.calls[0][0])).not.toContain(
      "playerone@example.com"
    );
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
      "[Sample] Roo Industries appeal submitted: Map result dispute"
    );
    expect(adminTemplate.html).toContain("New Roo Industries appeal");
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
