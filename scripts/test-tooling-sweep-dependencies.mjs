import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
const evidence = [];
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
const bounded = expansion("{a}" + "}".repeat(128000) + ",z}");
assert.ok(Array.isArray(bounded));
const braces = total => "{a}" + "}".repeat(total - 6) + ",z}";
const braceCpuMs = (total, calls) => {
  const input = braces(total);
  assert.equal(input.length, total);
  const before = process.cpuUsage();
  for (let call = 0; call < calls; call++) {
    assert.ok(Array.isArray(expansion(input)));
  }
  const used = process.cpuUsage(before);
  return (used.user + used.system) / 1000;
};
const braceShort = 8000;
const braceStep = longTotal => {
  const rounds = Array.from({ length: 5 }, () => [
    braceCpuMs(longTotal, 1),
    braceCpuMs(braceShort, longTotal / braceShort),
  ]);
  return {
    totalCharacters: longTotal,
    cpuMs: Math.min(...rounds.map(([long]) => long)),
    sameBytesShortCpuMs: Math.min(...rounds.map(([, short]) => short)),
  };
};
const braceSteps = [];
for (const longTotal of [128000, 1024000]) {
  const step = braceStep(longTotal);
  braceSteps.push(step);
  if (step.cpuMs >= 8 * step.sameBytesShortCpuMs) {
    break;
  }
}
assert.ok(braceSteps.every(step => step.cpuMs < 4 * step.sameBytesShortCpuMs));
evidence.push({
  check: "brace-expansion-documented-boundary",
  literalClosingBraces: 128000,
  outputs: bounded.length,
  steps: braceSteps,
});
const postcss=require("postcss");assert.match(postcss([]).process("a { color: red }",{from:undefined,map:false}).css,/color: red/);assert.ok(require("browserslist")(["last 1 chrome version"]).length>0);
evidence.push({check:"retained-native-build-parser-apis",packages:["postcss","browserslist"]});
const artifact="test-results/tooling-dependencies.json";fs.mkdirSync("test-results",{recursive:true});fs.writeFileSync(artifact,JSON.stringify({passed:true,evidence},null,2)+"\n");console.log(JSON.stringify({passed:true,checks:evidence.length,artifact}));
