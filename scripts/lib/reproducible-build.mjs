import { createHash } from "node:crypto";

const pluginName = "StableModuleIdsPlugin";

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

class StableModuleIdsPlugin {
  apply(compiler) {
    compiler.hooks.compilation.tap(pluginName, (compilation) => {
      if (compiler.options.optimization.moduleIds !== "deterministic") return;
      compilation.hooks.moduleIds.tap({ name: pluginName, stage: -100 }, (modules) => {
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
        if (!pending.length) return;
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

const sortedEntries = (entries) =>
  Object.fromEntries(Object.keys(entries).sort().map((name) => [name, entries[name]]));

export const makeBuildReproducible = (config) => {
  const entry = config.entry;
  config.entry = async () => sortedEntries(typeof entry === "function" ? await entry() : entry);
  config.plugins.push(new StableModuleIdsPlugin());
  return config;
};
