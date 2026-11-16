import fs from "node:fs";
import path from "node:path";
import { FIXED_GROUPS, REST_GROUPS, reportTests } from "../playwright-groups.mjs";

const PLAN_FILE = "plan.json";
const WORKER_COUNTS = [1, 2];
const REPEAT_EACH = 2;
const RETRIES = 0;
const FINISHED = ["passed", "failed", "timedOut", "skipped"];
const HEAD_SHA = /^[0-9a-f]{40}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const key = (id) => JSON.stringify(id);
const shown = (idKey) => {
  const [file, line, column, project, titles] = JSON.parse(idKey);
  return `${file}:${line}:${column} [${project}] ${JSON.stringify(titles)}`;
};
const counted = (what, keys) => `${what}: ${keys.length}, first ${shown(keys[0])}`;

export const planProblems = (plan) => {
  if (!isObject(plan)) return ["The plan is not a JSON object."];
  const problems = [];
  if (typeof plan.head_sha !== "string" || !HEAD_SHA.test(plan.head_sha)) problems.push("The plan names no commit (head_sha).");
  if (!WORKER_COUNTS.includes(plan.workers)) {
    problems.push(`The plan runs ${JSON.stringify(plan.workers)} tests at a time; a proof runs ${WORKER_COUNTS.join(" or ")}.`);
  }
  if (!Array.isArray(plan.legs) || !plan.legs.length) problems.push("The plan has no legs.");
  if (!isObject(plan.tests)) problems.push("The plan lists no tests (tests).");
  if (problems.length) return problems;

  for (const [file, ids] of Object.entries(plan.tests)) {
    if (!Array.isArray(ids) || !ids.every((id) => Array.isArray(id) && id[0] === file)) {
      problems.push(`The plan's tests of ${file} are not a list of that file's test ids.`);
    }
  }
  const fixedFiles = new Set(Object.values(FIXED_GROUPS).flat());
  const restFiles = Object.keys(plan.tests).filter((file) => !fixedFiles.has(file));
  const names = new Set();
  const restLegs = new Map();
  for (const leg of plan.legs) {
    if (!isObject(leg) || !Number.isInteger(leg.repeat) || leg.repeat < 1 || leg.name !== `${leg.group}-${leg.repeat}`) {
      problems.push(`Leg ${JSON.stringify(leg?.name)} is not named <group>-<repeat>.`);
      continue;
    }
    if (names.has(leg.name)) problems.push(`Leg ${leg.name} is planned twice.`);
    names.add(leg.name);
    const fixed = Object.hasOwn(FIXED_GROUPS, leg.group);
    if (!fixed && !REST_GROUPS.includes(leg.group)) {
      problems.push(`Leg ${leg.name} is in no known browser group.`);
      continue;
    }
    if (!Array.isArray(leg.files) || !leg.files.length) {
      problems.push(`Leg ${leg.name} has no spec files.`);
      continue;
    }
    const unlisted = leg.files.filter((file) => !Array.isArray(plan.tests[file]) || !plan.tests[file].length);
    if (unlisted.length) problems.push(`Leg ${leg.name} holds ${unlisted.join(", ")}, for which the plan lists no tests.`);
    if (!fixed) {
      restLegs.set(leg.repeat, [...(restLegs.get(leg.repeat) || []), leg]);
    } else if (JSON.stringify(leg.files) !== JSON.stringify(FIXED_GROUPS[leg.group])) {
      problems.push(`Leg ${leg.name} does not hold exactly ${FIXED_GROUPS[leg.group].join(", ")}, the file of its group.`);
    }
  }
  const repeats = new Set(plan.legs.map((leg) => leg?.repeat)).size;
  for (const [repeat, legs] of restLegs) {
    const owners = new Map();
    for (const leg of legs) {
      for (const file of leg.files) {
        if (!restFiles.includes(file)) problems.push(`Leg ${leg.name} holds ${file}, which is not a listed rest file.`);
        else if (owners.has(file)) problems.push(`Repeat ${repeat} gives ${file} to both ${owners.get(file)} and ${leg.name}.`);
        else owners.set(file, leg.name);
      }
    }
    const omitted = restFiles.filter((file) => !owners.has(file));
    if (legs.length === REST_GROUPS.length) {
      if (omitted.length) problems.push(`Repeat ${repeat} gives ${omitted.join(", ")} to no rest leg.`);
    } else if (repeats > 1) {
      problems.push(`Repeat ${repeat} has only some rest groups; across repeats only all rest groups together can be judged.`);
    }
  }
  return problems;
};

const judgeLeg = (plan, leg, file) => {
  if (!fs.existsSync(file)) return { reasons: ["it has no report"] };
  const text = fs.readFileSync(file, "utf8");
  if (!text.trim()) return { reasons: ["its report is empty"] };
  let report;
  try {
    report = JSON.parse(text);
  } catch (error) {
    return { reasons: [`its report is not one JSON document (${error.message})`] };
  }
  if (!isObject(report)) return { reasons: ["its report is not a JSON object"] };

  const reasons = [];
  if (report.config?.metadata?.proofLeg !== leg.name) {
    reasons.push(`its report carries the leg name ${JSON.stringify(report.config?.metadata?.proofLeg)}, not its own`);
  }
  if (report.config?.workers !== plan.workers) {
    reasons.push(`it ran ${JSON.stringify(report.config?.workers)} tests at a time, the plan says ${plan.workers}`);
  }
  const planned = leg.files.flatMap((specFile) => plan.tests[specFile]);
  const projects = Array.isArray(report.config?.projects) ? report.config.projects : [];
  if (!projects.length || !projects.every((project) => project?.retries === RETRIES)) {
    reasons.push(`not every project ran with ${RETRIES} retries`);
  }
  const unrepeated = [...new Set(planned.map((id) => id[3]))]
    .filter((name) => projects.find((project) => project?.name === name)?.repeatEach !== REPEAT_EACH);
  if (unrepeated.length) reasons.push(`project ${unrepeated.join(", ")} did not run each file ${REPEAT_EACH} times over`);
  if (!Array.isArray(report.errors) || report.errors.length) reasons.push("its report has errors outside the tests");

  const tests = reportTests(report).map(({ id, results }) => ({ id: key(id), results }));
  const seen = new Map();
  for (const { id } of tests) seen.set(id, (seen.get(id) || 0) + 1);
  const expected = new Set(planned.map((id) => key(id)));
  const miscounted = [...expected].filter((id) => seen.get(id) !== REPEAT_EACH);
  const unplanned = [...seen.keys()].filter((id) => !expected.has(id));
  const unfinished = tests
    .filter(({ results }) => !Array.isArray(results) || results.length !== 1 || !FINISHED.includes(results[0]?.status))
    .map(({ id }) => id);
  if (miscounted.length) {
    const first = `(${seen.get(miscounted[0]) || 0} times)`;
    reasons.push(`${counted(`planned tests not in its report exactly ${REPEAT_EACH} times`, miscounted)} ${first}`);
  }
  if (unplanned.length) reasons.push(counted("tests in its report not planned for it", unplanned));
  if (unfinished.length) reasons.push(counted("tests without exactly one finished result", unfinished));
  return { reasons, tests };
};

const tally = (statuses) => [...new Set(statuses)].sort()
  .map((status) => `${status} x${statuses.filter((other) => other === status).length}`).join(", ");

export const judgeRun = (dir) => {
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(path.join(dir, PLAN_FILE), "utf8"));
  } catch (error) {
    return { problems: [`${dir} has no ${PLAN_FILE} that parses (${error.message}).`] };
  }
  const problems = planProblems(plan);
  if (problems.length) return { problems };

  const planned = new Set([PLAN_FILE, ...plan.legs.map((leg) => `${leg.name}.json`)]);
  for (const entry of fs.readdirSync(dir)) {
    if (!planned.has(entry)) problems.push(`${entry} is not a report of a planned leg.`);
  }
  const outcomes = new Map();
  for (const leg of plan.legs) {
    let judged;
    try {
      judged = judgeLeg(plan, leg, path.join(dir, `${leg.name}.json`));
    } catch (error) {
      judged = { reasons: [`its report could not be read as a Playwright report (${error.message})`] };
    }
    if (judged.reasons.length) {
      problems.push(...judged.reasons.map((reason) => `Leg ${leg.name}: ${reason}.`));
      continue;
    }
    for (const { id, results } of judged.tests) outcomes.set(id, [...(outcomes.get(id) || []), results[0].status]);
  }
  if (problems.length) return { problems };

  const unstable = [...outcomes].filter(([, statuses]) => new Set(statuses).size > 1);
  return {
    problems,
    judged: [
      `Every planned leg is complete. Legs: ${plan.legs.length}. Tests: ${outcomes.size}. Tests at a time: ${plan.workers}.`,
      "\nOutcomes of each test across all legs:",
      ...[...outcomes].map(([id, statuses]) => `${tally(statuses)}  ${shown(id)}`),
      `\nTests with more than one outcome: ${unstable.length}`,
      ...unstable.map(([id, statuses]) => `  ${shown(id)}: ${tally(statuses)}`),
    ],
  };
};
