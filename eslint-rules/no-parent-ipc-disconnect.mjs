const pageRunners = new Set([
  "evaluate", "evaluateHandle", "evaluateAll", "waitForFunction", "addInitScript", "$eval", "$$eval",
]);
const inPage = (node) => node.parent?.type === "CallExpression" && node.parent.arguments.includes(node) &&
  node.parent.callee.type === "MemberExpression" && pageRunners.has(node.parent.callee.property.name);
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
      const values = [
        ...binding.defs.map((definition) => definition.type === "Variable" ? definition.node.init : undefined),
        ...binding.references.filter((reference) => reference.writeExpr).map((reference) => reference.writeExpr),
      ].filter((value) => !isEmpty(value));
      return binding.defs.every((definition) => definition.type === "Variable") && values.length > 0 &&
        values.every((value) => value.type === "NewExpression");
    };
    return {
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.name !== "disconnect") return;
        if (callee.object.type === "Identifier" && callee.object.name === "process") return;
        if (callee.object.type === "Super" || node.arguments.length || constructed(callee.object)) return;
        if (context.sourceCode.getAncestors(node).some(inPage)) return;
        context.report({ node, messageId: "parent" });
      },
    };
  },
};
