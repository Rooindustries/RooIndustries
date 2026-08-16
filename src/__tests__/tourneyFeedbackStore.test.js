const loadStores = () => {
  jest.resetModules();
  return {
    appeals: require("../server/tourney/appealPayoutStore.js"),
    feedback: require("../server/tourney/feedbackStore.js"),
  };
};

const env = {
  TOURNEY_APPEAL_PAYOUT_STORE_MODE: "memory",
  TOURNEY_DATABASE_MODE: "memory",
};

const adminSession = {
  username: "serviroo",
  role: "owner",
};

const validPayload = {
  overallRating: 5,
  organizationRating: 4,
  communicationRating: 4,
  formatRating: 5,
  broadcastRating: 5,
  returnIntent: "yes",
  feedbackText: "Lobby details arrived late and should be shared earlier.",
};

describe("anonymous Tourney participant feedback store", () => {
  afterEach(() => {
    const { appeals } = loadStores();
    appeals.resetMemoryTourneyAppealPayoutStoreForTests();
    jest.resetModules();
  });

  test("stores feedback without participant identity and preserves historical appeals", async () => {
    const { appeals, feedback } = loadStores();
    appeals.resetMemoryTourneyAppealPayoutStoreForTests();

    await appeals.createTourneyAppeal({
      payload: {
        type: "team-appeal",
        title: "Historical score appeal",
        details: "Keep this existing appeal intact.",
      },
      session: { username: "player-one", role: "player", playerId: "player-1" },
      env,
    });
    const created = await feedback.createTourneyFeedback({
      payload: validPayload,
      env,
    });

    expect(created).toMatchObject({
      overallRating: 5,
      returnIntent: "yes",
      feedbackText: validPayload.feedbackText,
    });
    expect(created).not.toHaveProperty("submitterPlayerId");
    expect(created).not.toHaveProperty("submitterUsername");
    expect(created).not.toHaveProperty("teamName");

    await expect(
      feedback.listTourneyFeedbackForSession({ session: adminSession, env })
    ).resolves.toEqual([created]);
    await expect(
      appeals.listTourneyAppealsForSession({ session: adminSession, env })
    ).resolves.toHaveLength(2);

    const records = await appeals.listTourneyAppealsForSession({
      session: adminSession,
      env,
    });
    const storedFeedback = records.find(
      (record) => record.subjectName === feedback.TOURNEY_FEEDBACK_MARKER
    );
    expect(storedFeedback).toMatchObject({
      submitterPlayerId: "",
      submitterUsername: "anonymous-participant",
      teamName: "",
      captainName: "",
    });
  });

  test("accepts separate anonymous responses without an account restriction", async () => {
    const { appeals, feedback } = loadStores();
    appeals.resetMemoryTourneyAppealPayoutStoreForTests();

    await feedback.createTourneyFeedback({ payload: validPayload, env });
    await feedback.createTourneyFeedback({
      payload: { ...validPayload, overallRating: 3 },
      env,
    });

    await expect(
      feedback.listTourneyFeedbackForSession({ session: adminSession, env })
    ).resolves.toHaveLength(2);
  });

  test("validates ratings and the single written feedback field", () => {
    const { feedback } = loadStores();
    const result = feedback.validateTourneyFeedbackPayload({
      ...validPayload,
      overallRating: 6,
      returnIntent: "unsure",
      feedbackText: "",
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      "Give every required rating from 1 to 5.",
      "Tell us whether you would take part again.",
      "Tell us what was bad or what we should improve.",
    ]));
  });
});
