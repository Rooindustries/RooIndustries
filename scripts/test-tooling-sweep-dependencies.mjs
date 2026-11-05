import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { compareUntilSlow, cpuMsOf } from "./lib/input-scaling.mjs";
const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const evidence = [];
const braceAdvisory = "GHSA-q2hr-2g5m-vwhr";
const braceVulnerableRanges = [
  ["0.0.0", "1.1.21"],
  ["2.0.0", "2.1.7"],
  ["3.0.0", "3.0.9"],
  ["4.0.0", "5.0.12"],
];
const versionParts = version => version.split(".").map(part => Number.parseInt(part, 10));
const compareVersions = (left, right) => {
  const [a, b] = [versionParts(left), versionParts(right)];
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
};
const braceVersions = Object.keys(lock.packages)
  .filter(location => location.endsWith("node_modules/brace-expansion"))
  .map(location => ({
    location,
    locked: lock.packages[location].version,
    installed: JSON.parse(fs.readFileSync(`${location}/package.json`, "utf8")).version,
  }));
const isVulnerableBrace = version => braceVulnerableRanges.some(([from, patched]) => {
  return compareVersions(version, from) >= 0 && compareVersions(version, patched) < 0;
});
const vulnerableBraceVersions = braceVersions.filter(({ locked, installed }) => {
  return isVulnerableBrace(locked) || isVulnerableBrace(installed);
});
assert.ok(braceVersions.length > 0);
const vulnerableBraceDetails = JSON.stringify(vulnerableBraceVersions);
assert.deepEqual(
  vulnerableBraceVersions,
  [],
  `brace-expansion is inside the ${braceAdvisory} vulnerable range: ${vulnerableBraceDetails}`,
);
evidence.push({ check: "brace-expansion-patched-version", advisory: braceAdvisory, versions: braceVersions });
for (const field of ["dependencies", "devDependencies"]) assert.deepEqual(lock.packages[""][field], manifest[field]);
evidence.push({check:"native-manifest-lock-consistency",rule:"D2/D6",directDependencies:Object.keys(manifest.dependencies).length});
const installed=[];
for(const [location,entry] of Object.entries(lock.packages)) {
  if(!location || !fs.existsSync(`${location}/package.json`))continue;
  const actual=JSON.parse(fs.readFileSync(`${location}/package.json`,"utf8"));assert.equal(actual.version,entry.version,location);installed.push({location,version:actual.version});
}
evidence.push({check:"installed-root-lock-consistency",installed});
assert.equal(manifest.dependencies.sharp,"0.35.5");assert.equal(JSON.parse(fs.readFileSync("node_modules/sharp/package.json", "utf8")).version,"0.35.5");
for(const name of ["@sanity/client","@sanity/image-url"])assert.equal(lock.packages[`node_modules/${name}`],undefined);
assert.ok(manifest.dependencies["groq-js"]);assert.ok(manifest.dependencies["@portabletext/react"]);assert.equal(fs.existsSync("rooindustries"),false);
evidence.push({check:"native-direct-sharp-and-vendor-retirement",sharp:"0.35.5"});
const expansion=require("brace-expansion");assert.deepEqual(expansion("a{b,c}d"),["abd","acd"]);
const artifact = "test-results/tooling-dependencies.json";
const writeReport = passed => {
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync(artifact, JSON.stringify({ passed, evidence }, null, 2) + "\n");
};
const braces = total => "{a}" + "}".repeat(total - 6) + ",z}";
const braceOutputs = {};
const braceCpuMs = async (total, calls) => {
  const input = braces(total);
  assert.equal(input.length, total);
  let output;
  const cpuMs = await cpuMsOf(() => {
    for (let call = 0; call < calls; call++) {
      output = expansion(input);
    }
  });
  assert.ok(Array.isArray(output));
  braceOutputs[total] = output.length;
  return cpuMs;
};
const braceShort = 8000;
const braceRatioLimit = 4;
const braceSteps = await compareUntilSlow(
  [128000, 1024000].map(longTotal => ({
    details: { totalCharacters: longTotal },
    measure: side => {
      if (side === "long") {
        return braceCpuMs(longTotal, 1);
      }
      return braceCpuMs(braceShort, longTotal / braceShort);
    },
  })),
  { rounds: 7, limit: braceRatioLimit },
);
const braceRatios = braceSteps.map(step => [step.totalCharacters, Number(step.ratio.toFixed(2))]);
evidence.push({
  check: "brace-expansion-documented-boundary",
  advisory: braceAdvisory,
  totalCharacters: braceSteps[0].totalCharacters,
  outputs: braceOutputs[braceSteps[0].totalCharacters],
  steps: braceSteps,
});
const slowBraceSteps = braceSteps.filter(step => step.slow);
if (slowBraceSteps.length > 0) {
  writeReport(false);
}
assert.deepEqual(slowBraceSteps, [], `brace expansion cost grew faster than its input: ${JSON.stringify(braceRatios)}`);
const postcss=require("postcss");assert.match(postcss([]).process("a { color: red }",{from:undefined,map:false}).css,/color: red/);assert.ok(require("browserslist")(["last 1 chrome version"]).length>0);
evidence.push({check:"retained-native-build-parser-apis",packages:["postcss","browserslist"]});
writeReport(true);
console.log(JSON.stringify({ passed: true, checks: evidence.length, artifact }));
