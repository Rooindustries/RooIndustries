export default {
  meta: {
    type: "problem",
    schema: [],
    messages: { contained: "Start fixture processes through fixture-tools.mjs and PostgreSQL through start-postgres.mjs." },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!["child_process", "node:child_process"].includes(node.source.value)) return;
        for (const specifier of node.specifiers) {
          context.report({ node: specifier, messageId: "contained" });
        }
      },
      Literal(node) {
        if (typeof node.value === "string" && /(?:^|\/)pg_ctl$/.test(node.value)) {
          context.report({ node, messageId: "contained" });
        }
        if (typeof node.value === "string" && /(?:^|\/)(?:start-on-port|process-group)\.mjs$/.test(node.value)) {
          context.report({ node, messageId: "contained" });
        }
        if (["child_process", "node:child_process"].includes(node.value) && node.parent.type !== "ImportDeclaration") {
          context.report({ node, messageId: "contained" });
        }
      },
    };
  },
};
