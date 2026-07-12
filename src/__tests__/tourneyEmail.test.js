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

  test("reuses the provider idempotency key after an accepted response times out", async () => {
    const deliveries = new Map();
    let firstAttempt = true;
    mockSendEmail.mockImplementation(async (_message, options = {}) => {
      const key = options.idempotencyKey;
      if (!deliveries.has(key)) deliveries.set(key, `email_${deliveries.size + 1}`);
      if (firstAttempt) {
        firstAttempt = false;
        throw Object.assign(new Error("response timed out"), { code: "ETIMEDOUT" });
      }
      return { data: { id: deliveries.get(key) }, error: null };
    });
    const email = loadEmail();
    const input = {
      to: "playerone@example.com",
      baseUrl: "https://www.rooindustries.com",
      idempotencyKey: "command:discord_invite:player_1:v2:recipient:hash",
      env: { RESEND_API_KEY: "re_test", FROM_EMAIL: "Tourney <tourney@rooindustries.com>" },
      player: { id: "player_1", email: "playerone@example.com", displayName: "Player One" },
    };

    await expect(email.sendTourneyDiscordInviteEmail(input)).rejects.toMatchObject({
      code: "ETIMEDOUT",
    });
    await expect(email.sendTourneyDiscordInviteEmail(input)).resolves.toEqual({
      id: "email_1",
    });
    expect(deliveries.size).toBe(1);
    expect(mockSendEmail.mock.calls[0][1]).toEqual(mockSendEmail.mock.calls[1][1]);
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
          displayName: "Player One",
          approvedRolePlay: "Support",
          registrationPool: "main",
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
    expect(mockSendEmail.mock.calls[0][0].html).toContain("Player One");
    expect(mockSendEmail.mock.calls[0][0].html).toContain("approved as");
    expect(mockSendEmail.mock.calls[0][0].html).toContain("Support");
    expect(mockSendEmail.mock.calls[0][0].text).toContain(
      "Tournament pool: main pool."
    );
  });

  test("sends host approval emails with one accept link per submitted role", async () => {
    mockSendEmail.mockResolvedValue({
      data: { id: "email_host_approval" },
      error: null,
    });
    const email = loadEmail();

    await expect(
      email.sendTourneyRegistrationApprovalEmails({
        player: {
          displayName: "Player One",
          discord: "PlayerOne#1234",
          battlenet: "PlayerOne#9876",
          rank: "Master",
          rolePlay: "Support",
          primaryRolePlay: "Support",
          secondaryRolePlay: "Damage",
          timezone: "Eastern Time (ET)",
          twitchUsername: "playerone",
          availableAug12: true,
        },
        tokens: [
          {
            token: "approve_token",
            purpose: "approve",
            recipient_email: "host@rooindustries.com",
          },
          {
            token: "deny_token",
            purpose: "deny",
            recipient_email: "host@rooindustries.com",
          },
        ],
        baseUrl: "https://www.rooindustries.com",
        env: {
          NODE_ENV: "test",
          RESEND_API_KEY: "re_test",
          FROM_EMAIL: "Tourney <tourney@rooindustries.com>",
        },
      })
    ).resolves.toEqual([{ id: "email_host_approval" }]);

    const html = mockSendEmail.mock.calls[0][0].html;
    expect(html).toContain("Primary Role: Support");
    expect(html).toContain("Secondary Role: Damage");
    expect(html).toContain("Accept as Support");
    expect(html).toContain("Accept as Damage");
    expect(html).toContain("/tourney/decision#token=");
    expect(html).not.toContain("/api/tourney/registration-decision?token=");
    expect(html).toContain("decision=approve&amp;role=Support");
    expect(html).toContain("decision=approve&amp;role=Damage");
    expect(html).toContain("Deny");
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
        approvedRolePlay: "Support",
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
        approvedRolePlay: "Support",
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
        DISCORD_GUILD_ID: "111111111111111111",
        DISCORD_PARTICIPANT_ROLE_ID: "222222222222222222",
        DISCORD_HOST_ROLE_ID: "333333333333333333",
      },
    });

    const html = mockSendEmail.mock.calls[0][0].html;
    expect(html).toContain("/tourney/discord");
    expect(html).not.toContain("#token=");
    expect(html).not.toContain("/api/tourney/discord/start?token=");
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
