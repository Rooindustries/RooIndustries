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
assert.equal(manifest.dependencies.sharp,"0.35.4");assert.equal(JSON.parse(fs.readFileSync("node_modules/sharp/package.json", "utf8")).version,"0.35.4");
for(const name of ["@sanity/client","@sanity/image-url"])assert.equal(lock.packages[`node_modules/${name}`],undefined);
assert.ok(manifest.dependencies["groq-js"]);assert.ok(manifest.dependencies["@portabletext/react"]);assert.equal(fs.existsSync("rooindustries"),false);
evidence.push({check:"native-direct-sharp-and-vendor-retirement",sharp:"0.35.4"});
const expansion=require("brace-expansion");assert.deepEqual(expansion("a{b,c}d"),["abd","acd"]);
const started=performance.now(),bounded=expansion("{a}"+"}".repeat(128000)+",z}");assert.ok(Array.isArray(bounded));const elapsedMs=performance.now()-started;assert.ok(elapsedMs<5000);
evidence.push({check:"brace-expansion-documented-boundary",literalClosingBraces:128000,elapsedMs,outputs:bounded.length});
const postcss=require("postcss");assert.match(postcss([]).process("a { color: red }",{from:undefined,map:false}).css,/color: red/);assert.ok(require("browserslist")(["last 1 chrome version"]).length>0);
evidence.push({check:"retained-native-build-parser-apis",packages:["postcss","browserslist"]});
const artifact="test-results/tooling-dependencies.json";fs.mkdirSync("test-results",{recursive:true});fs.writeFileSync(artifact,JSON.stringify({passed:true,evidence},null,2)+"\n");console.log(JSON.stringify({passed:true,checks:evidence.length,artifact}));
