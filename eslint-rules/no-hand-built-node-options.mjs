import { calleeName, constValue } from "./util.mjs";

const helpers = new Set(["appendNodeOption", "prependNodeOption"]);
const keepsOneSide = new Set(["??", "||"]);
const setsWhenEmpty = new Set(["=", "??=", "||=", "&&="]);

const keyName = (node, computed) => {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
};

const readsNodeOptions = (node) =>
  node.type === "MemberExpression" && keyName(node.property, node.computed) === "NODE_OPTIONS";

const unwrap = (node) => (node?.type === "ChainExpression" ? node.expression : node);

const isAllowed = (context, value, seen = new Set()) => {
  const node = unwrap(value);
  if (!node || seen.has(node)) return false;
  seen.add(node);
  switch (node.type) {
    case "Literal":
      return node.value === null || typeof node.value === "string";
    case "TemplateLiteral":
      return !node.expressions.length;
    case "Identifier":
      return node.name === "undefined" || isAllowed(context, constValue(context, node), seen);
    case "UnaryExpression":
      return node.operator === "void";
    case "CallExpression":
      return helpers.has(calleeName(node));
    case "MemberExpression":
      return readsNodeOptions(node);
    case "ConditionalExpression":
      return isAllowed(context, node.consequent, seen) && isAllowed(context, node.alternate, seen);
    case "LogicalExpression":
      return keepsOneSide.has(node.operator) && isAllowed(context, node.left, seen) && isAllowed(context, node.right, seen);
    default:
      return false;
  }
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "NODE_OPTIONS may only be set from the quoting helpers, a plain string, or an existing NODE_OPTIONS value, because a hand-built value leaves module paths unquoted.",
    },
    messages: {
      handBuilt:
        "Set NODE_OPTIONS with withNodeOption or appendNodeOption from scripts/lib/node-options.mjs, a plain string, or an existing NODE_OPTIONS value, so a path with a space or a quote still loads.",
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        if (node.parent.type !== "ObjectExpression" || keyName(node.key, node.computed) !== "NODE_OPTIONS") return;
        if (node.kind !== "init" || !isAllowed(context, node.value)) context.report({ node: node.value, messageId: "handBuilt" });
      },
      AssignmentExpression(node) {
        if (unwrap(node.left).type !== "MemberExpression" || !readsNodeOptions(unwrap(node.left))) return;
        if (!setsWhenEmpty.has(node.operator) || !isAllowed(context, node.right)) context.report({ node: node.right, messageId: "handBuilt" });
      },
    };
  },
};
