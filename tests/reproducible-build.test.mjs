import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { makeBuildReproducible } from "../scripts/lib/reproducible-build.mjs";

const require = createRequire(import.meta.url);
const bundled = require("next/dist/compiled/webpack/webpack");
bundled.init();
const { webpack } = bundled;

const scratch = await mkdtemp(join(tmpdir(), "roo-reproducible-build-"));
after(() => rm(scratch, { recursive: true, force: true }));

const project = async (name, { pathInQuery = true } = {}) => {
  const dir = join(scratch, name, "site");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "a.js"), 'import { b } from "./b.js";\nconsole.log(b);\n');
  await writeFile(join(dir, "b.js"), 'export const b = "b";\n');
  const request = pathInQuery ? `./a.js?page=${encodeURIComponent(join(dir, "b.js"))}` : "./a.js";
  return { dir, entry: { zeta: "./b.js", alpha: request } };
};

const compile = (config) => new Promise((resolve, reject) => {
  webpack(config, (error, stats) => {
    if (error) return reject(error);
    const json = stats.toJson({ all: false, errors: true, modules: true, ids: true, entrypoints: true });
    if (stats.hasErrors()) return reject(new Error(json.errors.map((entry) => entry.message).join("\n")));
    resolve(json);
  });
});

const configFor = ({ dir, entry }, { stable = true, moduleIds } = {}) => {
  const config = {
    mode: "production", target: "node", context: dir, entry, plugins: [],
    output: { path: join(dir, "out") }, optimization: { minimize: false, concatenateModules: false, moduleIds },
  };
  return stable ? makeBuildReproducible(config) : config;
};

const ids = (json) => json.modules.map((module) => module.id).sort();

test("module ids change with the checkout path without the plugin", async () => {
  const first = await compile(configFor(await project("plain-one"), { stable: false }));
  const second = await compile(configFor(await project("plain-elsewhere"), { stable: false }));
  assert.notDeepEqual(ids(first), ids(second));
});

test("module ids and entry order match across checkout paths with the plugin", async () => {
  const first = await compile(configFor(await project("stable-one")));
  const second = await compile(configFor(await project("stable-elsewhere")));
  assert.deepEqual(ids(first), ids(second));
  assert.deepEqual(Object.keys(first.entrypoints), ["alpha", "zeta"]);
});

test("a build with another module id strategy fails", async () => {
  await assert.rejects(compile(configFor(await project("named"), { moduleIds: "named" })),
    /expects deterministic module ids, but this build uses named/);
});

test("a build where no module carries the project path fails", async () => {
  await assert.rejects(compile(configFor(await project("no-path", { pathInQuery: false }))),
    /no module in the main build has the project path in its request/);
});

test("webpack internals the plugin relies on must exist", async () => {
  const config = configFor(await project("internals"));
  config.plugins.unshift({ apply: (compiler) => compiler.hooks.compilation.tap("drop", (compilation) => {
    compilation.hooks.moduleIds.tap({ name: "drop", stage: -200 }, () => {
      compilation.chunkGraph.setModuleId = undefined;
    });
    compilation.hooks.moduleIds.tap({ name: "restore", stage: -50 }, () => {
      delete compilation.chunkGraph.setModuleId;
    });
  }) });
  await assert.rejects(compile(config), /the webpack chunk graph has no setModuleId/);
});

test("an entry that is not a set of named entries fails", async () => {
  assert.throws(() => makeBuildReproducible({ entry: "./a.js", plugins: [] }),
    /expects the webpack entry to be an object of named entries/);
  const config = makeBuildReproducible({ entry: async () => ["./a.js"], plugins: [] });
  await assert.rejects(config.entry(), /expects the webpack entry to be an object of named entries/);
});
