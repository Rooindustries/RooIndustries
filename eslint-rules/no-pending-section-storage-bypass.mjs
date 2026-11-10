export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      owner: "Use the pending section helpers in src/lib/sectionNavigation.js.",
    },
  },
  create(context) {
    const filename = context.filename.replaceAll("\\", "/");
    if (filename.endsWith("/src/lib/sectionNavigation.js")) return {};
    const report = (node) => context.report({ node, messageId: "owner" });
    return {
      Identifier(node) {
        if (node.name === "PENDING_SECTION_KEY") report(node);
      },
      Literal(node) {
        if (node.value === "roo_pending_section") report(node);
      },
      TemplateElement(node) {
        if (node.value.cooked === "roo_pending_section") report(node);
      },
    };
  },
};
