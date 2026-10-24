import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function cleanupAccountFixture({ jobDir, pgBin, output, env, failures = [], pids = [] }) {
  const errors = [];
  const report = { stops: [], processes: [], removed: false };
  const knownPids = new Set(pids.filter(pid => Number.isInteger(pid) && pid > 0));
  let allStopped = true;
  let clusters = [];
  try { fs.mkdirSync(output, { recursive: true }); }
  catch (error) { errors.push(error); }
  const scratch = path.join(jobDir, "tmp");
  try { clusters = fs.readdirSync(scratch).sort(); }
  catch (error) { errors.push(error); allStopped = false; }
  for (const name of clusters) {
    const cluster = path.join(scratch, name);
    const dataDir = path.join(cluster, "pgdata");
    try {
      if (!name.startsWith("roo-account-domain-") || !fs.lstatSync(cluster).isDirectory()) throw new Error("Unexpected account fixture cleanup target");
      fs.chmodSync(cluster, 0o700);
      const pidFile = path.join(dataDir, "postmaster.pid");
      if (!fs.existsSync(pidFile)) continue;
      const pid = Number(fs.readFileSync(pidFile, "utf8").split("\n")[0]);
      if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid owned PostgreSQL PID");
      knownPids.add(pid);
      const stopped = spawnSync(path.join(pgBin, "pg_ctl"), ["-D", dataDir, "-m", "fast", "-w", "stop"], { encoding: "utf8", env });
      const log = [stopped.stdout, stopped.stderr, stopped.error?.message].filter(Boolean).join("\n");
      report.stops.push({ dataDir, pid, status: stopped.status, signal: stopped.signal, log });
      try { fs.writeFileSync(path.join(output, `${name}-owned-stop.log`), log); }
      catch (error) { errors.push(error); }
      if (stopped.status !== 0) throw new Error(`Owned PostgreSQL stop failed: ${log}`);
    } catch (error) { errors.push(error); allStopped = false; }
  }
  for (const pid of knownPids) {
    try {
      process.kill(pid, 0);
      report.processes.push({ pid, alive: true });
      errors.push(new Error(`Owned PostgreSQL process is still running: ${pid}`));
      allStopped = false;
    } catch (error) {
      if (error.code === "ESRCH") report.processes.push({ pid, alive: false });
      else { errors.push(error); allStopped = false; }
    }
  }
  if (allStopped) {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); report.removed = true; }
    catch (error) { errors.push(error); }
  }
  report.errors = [...failures, ...errors].map(error => String(error));
  try { fs.writeFileSync(path.join(output, "owned-cleanup.json"), `${JSON.stringify(report, null, 2)}\n`); }
  catch (error) { errors.push(error); }
  const allErrors = [...failures, ...errors];
  if (allErrors.length === 1) throw allErrors[0];
  if (allErrors.length) throw new AggregateError(allErrors, "Account fixture cleanup failed");
  return report;
}
