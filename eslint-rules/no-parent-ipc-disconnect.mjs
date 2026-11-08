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
      parent: "Let the child end the channel and unref it here, so close still fires. " +
        "Page code that stops an observer goes in tests/fixtures/browser/.",
    },
    schema: [],
  },
  create(context) {
    const declared = (identifier) => {
      for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
        if (scope.set.has(identifier.name)) return scope.set.get(identifier.name).defs.length > 0;
      }
      return false;
    };
    const check = (node, receiver) => {
      if (receiver?.type === "Super") return;
      if (receiver?.type === "Identifier" && receiver.name === "process" && !declared(receiver)) return;
      context.report({ node, messageId: "parent" });
    };
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || staticKey(callee) !== "disconnect" || node.arguments.length) return;
        check(node, callee.object);
      },
      Property(node) {
        if (node.parent.type !== "ObjectPattern" || staticKey(node) !== "disconnect") return;
        const parent = node.parent.parent;
        const receiver = parent.type === "VariableDeclarator" ? parent.init :
          parent.type === "AssignmentExpression" ? parent.right : null;
        check(node, receiver);
      },
    };
  },
};
