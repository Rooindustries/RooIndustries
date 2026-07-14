const mockGetTourneySql = jest.fn();
const mockReconcileExternal = jest.fn();
const mockReconcileEmails = jest.fn();
const mockReconcileMirror = jest.fn();
const mockRefreshCutoverClock = jest.fn();
const mockResolvePolicy = jest.fn();
const mockRunParity = jest.fn();
const mockRunShadowReads = jest.fn();
const mockCompleteReceipts = jest.fn();

jest.mock("../server/tourney/sqlClient.js", () => ({
  getTourneySql: (...args) => mockGetTourneySql(...args),
}));
jest.mock("../server/tourney/externalOperations.js", () => ({
  reconcileTourneyExternalOperations: (...args) => mockReconcileExternal(...args),
}));
jest.mock("../server/tourney/emailDispatch.js", () => ({
  reconcileTourneyEmailDispatches: (...args) => mockReconcileEmails(...args),
}));
jest.mock("../server/tourney/store.js", () => ({
  completeRecoveredTourneyCommandReceipts: (...args) => mockCompleteReceipts(...args),
  reconcileTourneyMirror: (...args) => mockReconcileMirror(...args),
  refreshTourneyCutoverClock: (...args) => mockRefreshCutoverClock(...args),
  resolveTourneyStorePolicy: (...args) => mockResolvePolicy(...args),
  runTourneyParity: (...args) => mockRunParity(...args),
  runTourneyShadowReadSamples: (...args) => mockRunShadowReads(...args),
}));

const {
  drainTourneyReconciliationQueues,
  runTourneyReconciliation,
} = require("../server/tourney/reconcile.js");

const configureLease = ({ acquired = true } = {}) => {
  let statementCount = 0;
  const root = jest.fn((input) => {
    if (typeof input === "string") return input;
    statementCount += 1;
    if (statementCount === 1) {
      return Promise.resolve(acquired ? [{ reconciliation_lease_id: "lease" }] : []);
    }
    return Promise.resolve([]);
  });
  mockGetTourneySql.mockResolvedValue(root);
  return { root };
};

describe("Tourney reconciliation orchestration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReconcileExternal.mockReset();
    configureLease();
    mockResolvePolicy.mockReturnValue({
      primaryBackend: "supabase",
      mirrorEnabled: true,
      writesPaused: false,
      generation: 1,
    });
    mockReconcileExternal.mockResolvedValueOnce({
      claimed: 2,
      applied: 0,
      retried: 1,
      deadLettered: 1,
    }).mockResolvedValue({
      claimed: 0,
      applied: 0,
      retried: 0,
      deadLettered: 0,
    });
    mockReconcileEmails.mockResolvedValue({ claimed: 1, sent: 0, retried: 1 });
    mockReconcileMirror.mockResolvedValue({ enabled: true, applied: 2, failed: 0 });
    mockRunParity.mockResolvedValue({ status: "clean" });
    mockRunShadowReads.mockResolvedValue({ samples: 50, mismatches: 0 });
    mockRefreshCutoverClock.mockResolvedValue({ clean_since: null });
    mockCompleteReceipts.mockResolvedValue({ completed: 1, failed: 0 });
  });

  test("runs full parity outside payment draining and preserves per-item outcomes", async () => {
    const result = await runTourneyReconciliation({ budgetMs: 60_000 });

    expect(result.skipped).toBe(false);
    expect(result.summary.tourneyExternalOperations).toEqual({
      claimed: 2,
      applied: 0,
      retried: 1,
      deadLettered: 1,
    });
    expect(mockReconcileExternal).toHaveBeenCalledWith({
      env: process.env,
      limit: 10,
      deadlineAt: expect.any(Number),
    });
    expect(mockReconcileExternal).toHaveBeenCalledTimes(2);
    expect(mockReconcileEmails).toHaveBeenCalledWith({
      env: process.env,
      limit: 10,
      deadlineAt: expect.any(Number),
    });
    expect(mockReconcileMirror).toHaveBeenCalledWith({
      env: process.env,
      limit: 100,
      deadlineAt: expect.any(Number),
    });
    expect(mockCompleteReceipts).toHaveBeenCalledWith({
      env: process.env,
      limit: 100,
      deadlineAt: expect.any(Number),
    });
    expect(mockRunParity).toHaveBeenCalledWith({
      env: process.env,
      deadlineAt: expect.any(Number),
    });
    expect(mockRunShadowReads).toHaveBeenCalledWith({
      env: process.env,
      rounds: 10,
      deadlineAt: expect.any(Number),
    });
    expect(mockRefreshCutoverClock).toHaveBeenCalledWith({
      env: process.env,
      deadlineAt: expect.any(Number),
    });
    expect(mockGetTourneySql.mock.results[0].value).toBeDefined();
  });

  test("skips overlapping workers under the durable database lease", async () => {
    const { root } = configureLease({ acquired: false });

    const result = await runTourneyReconciliation({ budgetMs: 60_000 });

    expect(result).toMatchObject({
      skipped: true,
      reason: "already_running",
      summary: {},
    });
    expect(mockResolvePolicy).toHaveBeenCalledTimes(1);
    expect(mockReconcileExternal).not.toHaveBeenCalled();
    expect(root.mock.calls[1][0].join(" ")).toContain("reconciliation_lease_id");
  });

  test("identifies an escaping stage failure and stops later checkpoints", async () => {
    const error = Object.assign(new Error("provider unavailable"), {
      code: "EMAIL_PROVIDER_UNAVAILABLE",
    });
    mockReconcileEmails.mockRejectedValue(error);

    await expect(runTourneyReconciliation({ budgetMs: 60_000 })).rejects.toMatchObject({
      code: "EMAIL_PROVIDER_UNAVAILABLE",
      failedStage: "tourneyEmails",
      partialSummary: {
        tourneyExternalOperations: {
          claimed: 2,
          applied: 0,
          retried: 1,
          deadLettered: 1,
        },
      },
    });
    expect(mockReconcileMirror).not.toHaveBeenCalled();
    expect(mockCompleteReceipts).not.toHaveBeenCalled();
    expect(mockRunParity).not.toHaveBeenCalled();
    expect(mockRefreshCutoverClock).not.toHaveBeenCalled();
  });

  test("fails before starting another stage when the budget is exhausted", async () => {
    const now = jest.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValue(2_000);
    try {
      await expect(runTourneyReconciliation({ budgetMs: 1_000 })).rejects.toMatchObject({
        code: "TOURNEY_RECONCILIATION_DEADLINE_EXCEEDED",
        failedStage: "tourneyPolicy",
      });
      expect(mockResolvePolicy).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  test("keeps payment-path draining bounded and omits parity work", async () => {
    const result = await drainTourneyReconciliationQueues({ budgetMs: 10_000 });

    expect(result.skipped).toBe(false);
    expect(mockReconcileExternal).toHaveBeenCalledWith({
      env: process.env,
      limit: 5,
      deadlineAt: expect.any(Number),
    });
    expect(mockReconcileExternal).toHaveBeenCalledTimes(2);
    expect(mockReconcileEmails).toHaveBeenCalledWith({
      env: process.env,
      limit: 5,
      deadlineAt: expect.any(Number),
    });
    expect(mockReconcileMirror).toHaveBeenCalledWith({
      env: process.env,
      limit: 25,
      deadlineAt: expect.any(Number),
    });
    expect(mockCompleteReceipts).toHaveBeenCalledWith({
      env: process.env,
      limit: 25,
      deadlineAt: expect.any(Number),
    });
    expect(mockRunParity).not.toHaveBeenCalled();
    expect(mockRunShadowReads).not.toHaveBeenCalled();
    expect(mockRefreshCutoverClock).not.toHaveBeenCalled();
  });
});
