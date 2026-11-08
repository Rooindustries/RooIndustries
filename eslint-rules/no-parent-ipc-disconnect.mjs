const staticKey = (node) => {
  const key = node.property ?? node.key;
  if (!node.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  if (key.type === "TemplateLiteral" && !key.expressions.length) return key.quasis[0].value.cooked;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "A child process whose parent ends its IPC channel never emits close.",
    },
    messages: {
      parent: "Only a child ends its own channel: call endOwnChannel() from scripts/lib/own-channel.mjs. " +
        "Page code that stops an observer goes in tests/fixtures/browser/.",
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (staticKey(node) === "disconnect") context.report({ node, messageId: "parent" });
      },
      Property(node) {
        if (node.parent.type === "ObjectPattern" && staticKey(node) === "disconnect") {
          context.report({ node, messageId: "parent" });
        }
      },
    };
  },
};
