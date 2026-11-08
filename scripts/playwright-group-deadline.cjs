const loadFixturePorts = require("../tests/fixtures/fixture-ports-setup.cjs");

module.exports = async function groupDeadline(config) {
  const { groupTimeoutMs, groupStartedAt } = config.metadata;
  if (!Number.isFinite(groupTimeoutMs) || groupTimeoutMs <= 0 || groupTimeoutMs >= config.globalTimeout ||
      !Number.isFinite(groupStartedAt)) {
    throw new Error("Playwright group deadline must leave time for shutdown and reports.");
  }
  const timer = setTimeout(() => {
    process.stderr.write(`Playwright group exceeded ${groupTimeoutMs}ms; interrupting the active test to retain its trace.\n`);
    process.kill(process.pid, "SIGINT");
  }, Math.max(0, groupTimeoutMs - (performance.now() - groupStartedAt)));
  timer.unref();
  try {
    await loadFixturePorts(config);
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  return () => clearTimeout(timer);
};
