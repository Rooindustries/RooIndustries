import crypto from "node:crypto";
import { reconcileTourneyEmailDispatches } from "./emailDispatch.js";
import { reconcileTourneyExternalOperations } from "./externalOperations.js";
import { getTourneySql } from "./sqlClient.js";
import {
  completeRecoveredTourneyCommandReceipts,
  reconcileTourneyMirror,
  refreshTourneyCutoverClock,
  resolveTourneyStorePolicy,
  runTourneyParity,
  runTourneyShadowReadSamples,
} from "./store.js";

export const TOURNEY_RECONCILIATION_BUDGET_MS = 270_000;
export const TOURNEY_PAYMENT_DRAIN_BUDGET_MS = 30_000;
const TOURNEY_RECONCILIATION_LEASE_GRACE_MS = 60_000;

const deadlineError = () => {
  const error = new Error("Tournament reconciliation exceeded its runtime budget.");
  error.code = "TOURNEY_RECONCILIATION_DEADLINE_EXCEEDED";
  error.status = 503;
  return error;
};

const assertBeforeDeadline = (deadlineAt) => {
  if (Date.now() >= deadlineAt) throw deadlineError();
};

const stageFailure = ({ error, failedStage, summary }) => {
  const failure = error instanceof Error
    ? error
    : new Error("Tournament reconciliation stage failed.");
  if (!failure.code) failure.code = "TOURNEY_RECONCILIATION_STAGE_FAILED";
  if (!failure.status) failure.status = 503;
  if (!failure.failedStage) failure.failedStage = failedStage;
  if (!failure.partialSummary) failure.partialSummary = { ...summary };
  return failure;
};

const runStage = async ({ failedStage, summary, deadlineAt, task }) => {
  try {
    assertBeforeDeadline(deadlineAt);
    const result = await task();
    summary[failedStage] = result;
    return result;
  } catch (error) {
    throw stageFailure({ error, failedStage, summary });
  }
};

const drainTourneyExternalOperationBatches = async ({
  env,
  deadlineAt,
  limit,
  maxBatches,
}) => {
  const total = { claimed: 0, applied: 0, retried: 0, deadLettered: 0 };
  for (let batch = 0; batch < maxBatches; batch += 1) {
    assertBeforeDeadline(deadlineAt);
    const result = await reconcileTourneyExternalOperations({
      env,
      limit,
      deadlineAt,
    });
    for (const key of Object.keys(total)) {
      total[key] += Number(result?.[key] || 0);
    }
    if (Number(result?.claimed || 0) === 0) break;
  }
  return total;
};

const executeQueueStages = async ({ env, deadlineAt, limits, summary = {} }) => {
  await runStage({
    failedStage: "tourneyExternalOperations",
    summary,
    deadlineAt,
    task: () => drainTourneyExternalOperationBatches({
      env,
      limit: limits.external,
      deadlineAt,
      maxBatches: limits.externalBatches,
    }),
  });
  await runStage({
    failedStage: "tourneyEmails",
    summary,
    deadlineAt,
    task: () => reconcileTourneyEmailDispatches({
      env,
      limit: limits.email,
      deadlineAt,
    }),
  });
  await runStage({
    failedStage: "tourneyMirror",
    summary,
    deadlineAt,
    task: () => reconcileTourneyMirror({
      env,
      limit: limits.mirror,
      deadlineAt,
    }),
  });
  await runStage({
    failedStage: "tourneyCommandReceipts",
    summary,
    deadlineAt,
    task: () => completeRecoveredTourneyCommandReceipts({
      env,
      limit: limits.receipts,
      deadlineAt,
    }),
  });
  return summary;
};

const executeFullReconciliation = async ({ env, deadlineAt }) => {
  const summary = {};
  const policy = await runStage({
    failedStage: "tourneyPolicy",
    summary,
    deadlineAt,
    task: () => resolveTourneyStorePolicy(env),
  });
  await executeQueueStages({
    env,
    deadlineAt,
    limits: {
      external: 10,
      externalBatches: 10,
      email: 10,
      mirror: 100,
      receipts: 100,
    },
    summary,
  });
  const root = await getTourneySql(env);
  const outboxTable = policy.primaryBackend === "supabase"
    ? "tourney.mirror_outbox"
    : "tourney_mirror_outbox";
  const [mirrorState] = await root`
    select count(*)::integer pending
    from ${root(outboxTable)}
    where status in ('pending','retry','processing')
  `;
  const mirrorInTransit = Number(mirrorState?.pending || 0) > 0;
  if (!policy.mirrorEnabled || summary.tourneyMirror.failed > 0 || mirrorInTransit) {
    summary.tourneyParity = {
      skipped: true,
      reason: !policy.mirrorEnabled
        ? "mirror_disabled"
        : summary.tourneyMirror.failed > 0
          ? "mirror_failures"
          : "mirror_in_transit",
    };
    summary.tourneyShadowReads = {
      skipped: true,
      reason: summary.tourneyParity.reason,
    };
  } else {
    const parity = await runStage({
      failedStage: "tourneyParity",
      summary,
      deadlineAt,
      task: () => runTourneyParity({ env, deadlineAt }),
    });
    if (parity.skipped) {
      summary.tourneyShadowReads = {
        skipped: true,
        reason: parity.reason || "parity_inconclusive",
      };
    } else {
      await runStage({
        failedStage: "tourneyShadowReads",
        summary,
        deadlineAt,
        task: () => runTourneyShadowReadSamples({ env, rounds: 10, deadlineAt }),
      });
    }
  }
  await runStage({
    failedStage: "tourneyCutoverClock",
    summary,
    deadlineAt,
    task: () => refreshTourneyCutoverClock({ env, deadlineAt }),
  });
  return summary;
};

export const withTourneyReconciliationLease = async ({
  env = process.env,
  leaseMs = TOURNEY_RECONCILIATION_BUDGET_MS,
  callback,
} = {}) => {
  if (typeof callback !== "function") {
    throw new Error("A Tourney reconciliation callback is required.");
  }
  const policy = resolveTourneyStorePolicy(env);
  const controlTable = policy.primaryBackend === "supabase"
    ? "tourney.cutover_metadata"
    : "tourney_cutover_metadata";
  const root = await getTourneySql(env);
  const leaseId = crypto.randomUUID();
  const safeLeaseMs = Math.max(
    60_000,
    Math.min(600_000, Number(leaseMs) + TOURNEY_RECONCILIATION_LEASE_GRACE_MS)
  );
  const acquired = await root`
    update ${root(controlTable)} set
      reconciliation_lease_id = ${leaseId},
      reconciliation_lease_expires_at = now() + ${safeLeaseMs} * interval '1 millisecond',
      reconciliation_heartbeat_at = now(),
      updated_at = now()
    where id = 'tourney'
      and (
        reconciliation_lease_id is null
        or reconciliation_lease_expires_at <= now()
      )
    returning reconciliation_lease_id
  `;
  if (acquired.length !== 1) return { acquired: false };
  try {
    return { acquired: true, value: await callback() };
  } finally {
    await root`
      update ${root(controlTable)} set
        reconciliation_lease_id = null,
        reconciliation_lease_expires_at = null,
        reconciliation_heartbeat_at = now(),
        updated_at = now()
      where id = 'tourney' and reconciliation_lease_id = ${leaseId}
    `;
  }
};

const runLeasedWork = async ({ env, budgetMs, work }) => {
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.max(1_000, Number(budgetMs) || 1_000);
  let leased;
  try {
    leased = await withTourneyReconciliationLease({
      env,
      leaseMs: budgetMs,
      callback: () => work({ deadlineAt }),
    });
  } catch (error) {
    throw stageFailure({ error, failedStage: "tourneyLease", summary: {} });
  }
  if (!leased.acquired) {
    return {
      skipped: true,
      reason: "already_running",
      durationMs: Date.now() - startedAt,
      summary: {},
    };
  }
  return {
    skipped: false,
    durationMs: Date.now() - startedAt,
    summary: leased.value,
  };
};

export const drainTourneyReconciliationQueues = ({
  env = process.env,
  budgetMs = TOURNEY_PAYMENT_DRAIN_BUDGET_MS,
} = {}) => runLeasedWork({
  env,
  budgetMs,
  work: ({ deadlineAt }) => executeQueueStages({
    env,
    deadlineAt,
    limits: {
      external: 5,
      externalBatches: 5,
      email: 5,
      mirror: 25,
      receipts: 25,
    },
  }),
});

export const runTourneyReconciliation = ({
  env = process.env,
  budgetMs = TOURNEY_RECONCILIATION_BUDGET_MS,
} = {}) => runLeasedWork({
  env,
  budgetMs,
  work: ({ deadlineAt }) => executeFullReconciliation({ env, deadlineAt }),
});
