export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      key: "Use a page-local counter for navigation keys so links work without a secure context.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "MemberExpression" && callee.property.name === "randomUUID") {
          context.report({ node, messageId: "key" });
        }
      },
    };
  },
};
