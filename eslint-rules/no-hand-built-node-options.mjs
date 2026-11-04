const isNodeOptionsKey = (node, computed) =>
  (!computed && node.type === "Identifier" && node.name === "NODE_OPTIONS") ||
  (node.type === "Literal" && node.value === "NODE_OPTIONS");

const isBuilt = (node) => {
  if (!node) return false;
  switch (node.type) {
    case "TemplateLiteral":
      return node.expressions.length > 0;
    case "BinaryExpression":
      return node.operator === "+";
    case "CallExpression":
      return node.callee.type === "MemberExpression" && !node.callee.computed &&
        ["join", "concat"].includes(node.callee.property.name);
    case "ConditionalExpression":
      return isBuilt(node.consequent) || isBuilt(node.alternate);
    case "LogicalExpression":
      return isBuilt(node.left) || isBuilt(node.right);
    default:
      return false;
  }
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "NODE_OPTIONS built from strings leaves module paths unquoted, so a checkout path with a space or quote stops Node from starting.",
    },
    messages: {
      handBuilt:
        "This builds NODE_OPTIONS by hand, which breaks when a path has a space or a quote. Use withNodeOption from scripts/lib/node-options.mjs.",
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        if (isNodeOptionsKey(node.key, node.computed) && isBuilt(node.value)) {
          context.report({ node: node.value, messageId: "handBuilt" });
        }
      },
      AssignmentExpression(node) {
        const { left } = node;
        if (left.type !== "MemberExpression" || !isNodeOptionsKey(left.property, left.computed)) return;
        if (node.operator === "+=" || isBuilt(node.right)) context.report({ node: node.right, messageId: "handBuilt" });
      },
    };
  },
};
