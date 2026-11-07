const pageRunners = new Set([
  "evaluate", "evaluateHandle", "evaluateAll", "waitForFunction", "addInitScript", "$eval", "$$eval",
]);
const pageCode = (node) => ["ArrowFunctionExpression", "FunctionExpression"].includes(node.type) &&
  node.parent?.type === "CallExpression" && node.parent.arguments.includes(node) &&
  node.parent.callee.type === "MemberExpression" && pageRunners.has(node.parent.callee.property.name);
const ownValue = ({ identifier }) => {
  const { parent } = identifier;
  if (parent.type === "VariableDeclarator" && parent.id === identifier) return parent.init;
  const assigned = parent.type === "AssignmentExpression" && parent.operator === "=" && parent.left === identifier;
  if (assigned) return parent.right;
  return false;
};
const isEmpty = (node) => !node || (node.type === "Literal" && node.value === null) ||
  (node.type === "Identifier" && node.name === "undefined");

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
    const variable = (node) => {
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        if (scope.set.has(node.name)) return scope.set.get(node.name);
      }
    };
    const constructed = (node) => {
      if (node.type === "NewExpression") return true;
      if (node.type !== "Identifier") return false;
      const binding = variable(node);
      if (!binding) return false;
      const values = binding.references.filter((reference) => reference.isWrite()).map(ownValue);
      if (values.includes(false) || !binding.defs.every((definition) => definition.type === "Variable")) return false;
      const held = values.filter((value) => !isEmpty(value));
      return held.length > 0 && held.every((value) => value.type === "NewExpression");
    };
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression") return;
        if ((callee.computed ? callee.property.value : callee.property.name) !== "disconnect") return;
        if (callee.object.type === "Identifier" && callee.object.name === "process") return;
        if (callee.object.type === "Super" || node.arguments.length || constructed(callee.object)) return;
        if (context.sourceCode.getAncestors(node).some(pageCode)) return;
        context.report({ node, messageId: "parent" });
      },
    };
  },
};
