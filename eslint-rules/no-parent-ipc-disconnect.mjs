export default {
  meta: {
    type: "problem",
    docs: {
      description: "A child process whose parent ends its IPC channel never emits close.",
    },
    messages: {
      parent: "Let the child end the channel and unref it here, so close still fires.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.name !== "disconnect") return;
        if (callee.object.type === "Identifier" && callee.object.name === "process") return;
        if (callee.object.type === "Super" || node.arguments.length) return;
        context.report({ node, messageId: "parent" });
      },
    };
  },
};
