const keyName = (key) => {
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return key.value;
  if (key.type === "TemplateLiteral" && !key.expressions.length) return key.quasis[0].value.cooked;
};
const namesRandomUUID = (key, computed) => !(computed && key.type === "Identifier") && keyName(key) === "randomUUID";

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
