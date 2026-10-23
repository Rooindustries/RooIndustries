module.exports = async function groupDeadline(config) {
  const timeout = config.metadata.groupTimeoutMs;
  const started = config.metadata.groupStartedAt;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout >= config.globalTimeout || !Number.isFinite(started)) {
    throw new Error("Playwright group deadline must leave time for shutdown and reports.");
  }
  const timer = setTimeout(() => {
    process.stderr.write(`Playwright group exceeded ${timeout}ms; interrupting the active test to retain its trace.\n`);
    process.kill(process.pid, "SIGINT");
  }, Math.max(0, timeout - (performance.now() - started)));
  timer.unref();
  return () => clearTimeout(timer);
};
