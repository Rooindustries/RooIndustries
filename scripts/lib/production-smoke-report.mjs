import { isLoopback } from "./production-diagnostics.mjs";

export const CHECK_NAMES = ["page /", "page /packages", "page /booking", "page /payment", "booking availability",
  "package prices", "referral capture", "home page renders", "booking page renders", "payment page renders"];

export const confirmationWait = () => {
  const fixture = [process.env.VERCEL_API_URL, process.env.GITHUB_API_URL, process.env.SMOKE_BASE_URL,
    process.env.SMOKE_PREVIOUS_BASE_URL].every(isLoopback);
  const requested = Number(process.env.GATE_CONFIRM_WAIT_MS || 180000);
  if (!Number.isFinite(requested) || requested <= 0) throw new Error("Invalid recovery confirmation interval.");
  return Math.max(fixture ? 1 : 120000, requested);
};

export const validateReport = report => {
  if (report?.version !== 1 || !Array.isArray(report.results) || report.results.length !== CHECK_NAMES.length ||
      !Number.isFinite(report.startedAt) || report.startedAt <= 0 || !Number.isFinite(report.completedAt) ||
      report.completedAt < report.startedAt || report.completedAt > Date.now() + 1000 ||
      CHECK_NAMES.some(name => report.results.filter(row => row.name === name).length !== 1) ||
      report.results.some(row => typeof row.ok !== "boolean" || (row.couldNotRun !== undefined && (row.couldNotRun !== true || row.ok)))) {
    throw new Error("The smoke report is incomplete or invalid; nothing was rolled back.");
  }
  return report;
};

export const differentialFailures = (current, previous) => {
  validateReport(current);
  validateReport(previous);
  const failed = current.results.filter(row => !row.ok && !row.couldNotRun).map(row => row.name);
  if (!failed.length || current.results.some(row => row.couldNotRun || row.initializationIncomplete) || previous.results.some(row => !row.ok)) {
    throw new Error("The previous deployment did not pass the same checks, or the comparison is inconclusive. Dependency incident or cold start: alert only; nothing was rolled back.");
  }
  return failed.sort();
};

export const verifyEvidence = (evidence, { sourceId, targetId, historyId, epoch, sourceBase, targetBase }) => {
  if (evidence?.version !== 1 || evidence.sourceId !== sourceId || evidence.targetId !== targetId ||
      evidence.historyId !== historyId || evidence.epoch !== epoch || evidence.rounds?.length !== 2) {
    throw new Error("Automatic recovery requires matching repeated comparison evidence.");
  }
  let names;
  let lastCompleted = 0;
  for (const round of evidence.rounds) {
    const failed = differentialFailures(round.current, round.previous);
    if (round.current.base !== sourceBase || round.previous.base !== targetBase ||
        round.previous.startedAt < round.current.completedAt ||
        (lastCompleted && round.current.startedAt - lastCompleted < confirmationWait()) ||
        (names && JSON.stringify(names) !== JSON.stringify(failed))) {
      throw new Error("Automatic recovery comparisons changed or were not separated by the confirmation interval.");
    }
    names = failed;
    lastCompleted = round.previous.completedAt;
  }
  if (lastCompleted > Date.now() + 1000 || Date.now() - lastCompleted > 300000) {
    throw new Error("Automatic recovery comparison evidence has expired.");
  }
};
