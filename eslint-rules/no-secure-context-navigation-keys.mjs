const namesRandomUUID = (key, computed) =>
  computed ? key.type === "Literal" && key.value === "randomUUID" : key.type === "Identifier" && key.name === "randomUUID";

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      key: "Use navigation keys that work without a secure context.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (namesRandomUUID(node.property, node.computed)) {
          context.report({ node, messageId: "key" });
        }
      },
      "ObjectPattern > Property"(node) {
        if (namesRandomUUID(node.key, node.computed)) {
          context.report({ node, messageId: "key" });
        }
      },
    };
  },
};
