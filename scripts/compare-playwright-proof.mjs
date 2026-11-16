const JUDGED = 0;
const CANNOT_JUDGE = 2;
const USAGE = "usage: compare-playwright-proof.mjs <run dir>";

process.exitCode = CANNOT_JUDGE;
try {
  const { judgeRun } = await import("./lib/playwright-proof.mjs");
  const dirs = process.argv.slice(2);
  const { problems, judged } = dirs.length === 1 ? judgeRun(dirs[0]) : { problems: [USAGE] };
  if (problems.length) {
    for (const problem of problems) console.error(problem);
    console.error(`Cannot judge this run. Reasons above: ${problems.length}. A run is judged only when every planned leg is complete.`);
  } else {
    for (const line of judged) console.log(line);
    process.exitCode = JUDGED;
  }
} catch (error) {
  console.error(`Cannot judge this run: ${error.message}`);
}
