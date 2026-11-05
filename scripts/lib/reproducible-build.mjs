import { createHash } from "node:crypto";

const pluginName = "StableModuleIdsPlugin";
const chunkGraphMethods = ["getModuleId", "setModuleId", "getNumberOfModuleChunks"];

const describe = (message) => `${pluginName}: ${message} Client chunk ids would depend on the checkout path.`;
const fail = (message) => {
  throw new Error(describe(message));
};

const rootForms = (root) => {
  const escaped = JSON.stringify(root).slice(1, -1);
  return [...new Set([root, escaped, encodeURIComponent(root), encodeURIComponent(escaped)])]
    .sort((a, b) => b.length - a.length);
};

const pathFreeIdentifier = (identifier, root) => {
  const forms = rootForms(root);
  const pathInQuery = identifier.split(/[|!]/).some((segment) => {
    const query = segment.indexOf("?");
    return query !== -1 && forms.some((form) => segment.includes(form, query));
  });
  if (!pathInQuery) return null;
  return forms.reduce((name, form) => name.split(form).join("<root>"), identifier);
};

const internalsProblem = (compilation, modules) => {
  const strategy = compilation.compiler.options.optimization?.moduleIds;
  if (strategy !== "deterministic") return `expects deterministic module ids, but this build uses ${strategy}.`;
  const missing = chunkGraphMethods.filter((name) => typeof compilation.chunkGraph?.[name] !== "function");
  if (missing.length) return `the webpack chunk graph has no ${missing.join(", ")}.`;
  if ([...modules].some((module) => typeof module.needId !== "boolean")) {
    return "webpack modules no longer say whether they need an id.";
  }
  return null;
};

const report = (compiler, compilation, message) => {
  const WebpackError = compiler.webpack?.WebpackError;
  if (typeof WebpackError !== "function") fail("this webpack has no WebpackError to report with.");
  compilation.errors.push(new WebpackError(describe(message)));
};

class StableModuleIdsPlugin {
  apply(compiler) {
    compiler.hooks.compilation.tap(pluginName, (compilation) => {
      if (!compilation.hooks.moduleIds) return report(compiler, compilation, "this webpack has no moduleIds hook.");
      compilation.hooks.moduleIds.tap({ name: pluginName, stage: -100 }, (modules) => {
        const problem = internalsProblem(compilation, modules);
        if (problem) return report(compiler, compilation, problem);
        const { chunkGraph } = compilation;
        const used = new Set([...(compilation.usedModuleIds || [])].map(String));
        const pending = [];
        let unassigned = 0;
        for (const module of modules) {
          if (!module.needId) continue;
          const id = chunkGraph.getModuleId(module);
          if (id !== null) {
            used.add(String(id));
            continue;
          }
          if (chunkGraph.getNumberOfModuleChunks(module) === 0) continue;
          unassigned++;
          const name = pathFreeIdentifier(module.identifier(), compiler.context);
          if (name) pending.push({ module, name });
        }
        if (!pending.length) {
          if (compilation.compiler.isChild()) return;
          return report(compiler, compilation,
            `no module in the ${compiler.name || "main"} build has the project path in its request.`);
        }
        let range = 1000;
        while (range < unassigned * 20 + used.size) range *= 10;
        pending.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const { module, name } of pending) {
          let salt = 0;
          let id;
          do {
            const digest = createHash("sha256").update(`${name}${salt++}`).digest("hex");
            id = Number.parseInt(digest.slice(0, 12), 16) % range;
          } while (used.has(String(id)));
          used.add(String(id));
          chunkGraph.setModuleId(module, id);
        }
      });
    });
  }
}

const isPlainObject = (value) => value !== null && Object.getPrototypeOf(value) === Object.prototype;

const sortedEntries = (entries) => {
  if (!isPlainObject(entries)) fail("expects the webpack entry to be an object of named entries.");
  return Object.fromEntries(Object.keys(entries).sort().map((name) => [name, entries[name]]));
};

export const makeBuildReproducible = (config) => {
  const entry = config.entry;
  if (typeof entry !== "function") sortedEntries(entry);
  config.entry = async () => sortedEntries(typeof entry === "function" ? await entry() : entry);
  config.plugins.push(new StableModuleIdsPlugin());
  return config;
};
