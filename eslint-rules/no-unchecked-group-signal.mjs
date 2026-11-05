const isProcessKill = (callee) =>
  callee.type === "MemberExpression" &&
  !callee.computed &&
  callee.object.type === "Identifier" &&
  callee.object.name === "process" &&
  callee.property.type === "Identifier" &&
  callee.property.name === "kill";

const isNegated = (node) => node?.type === "UnaryExpression" && node.operator === "-";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "A process group number is only ours while its leader is unreaped.",
    },
    messages: {
      unchecked: "Signal a group through signalGroup in scripts/lib/process-group.mjs.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isProcessKill(node.callee) || !isNegated(node.arguments[0])) return;
        context.report({ node, messageId: "unchecked" });
      },
    };
  },
};
