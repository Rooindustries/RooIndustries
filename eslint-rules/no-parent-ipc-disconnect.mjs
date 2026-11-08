const browserMethods = new Set(["evaluate", "evaluateHandle", "evaluateAll", "addInitScript", "$eval", "$$eval"]);
const browserHelpers = new Set(["evaluateBrowserTask"]);
const functions = new Set(["ArrowFunctionExpression", "FunctionExpression"]);
const pageGlobals = new Set(["window", "document", "self", "globalThis"]);
const staticKey = (node) => {
  const key = node.property ?? node.key;
  if (!node.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  if (key.type === "TemplateLiteral" && !key.expressions.length) return key.quasis[0].value.cooked;
};
const root = (node) => {
  let at = node;
  for (;;) {
    if (at?.type === "ChainExpression") at = at.expression;
    else if (at?.type === "MemberExpression") at = at.object;
    else if (at?.type === "CallExpression" || at?.type === "NewExpression") at = at.callee;
    else return at;
  }
};
const within = (node, outer) => node.range[0] >= outer.range[0] && node.range[1] <= outer.range[1];

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
    const binding = (identifier) => {
      for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
        if (scope.set.has(identifier.name)) return scope.set.get(identifier.name);
      }
    };
    const browserTask = (fn) => {
      const call = fn.parent;
      if (!functions.has(fn.type) || call?.type !== "CallExpression" || !call.arguments.includes(fn)) return false;
      const { callee } = call;
      if (callee.type === "Identifier") return browserHelpers.has(callee.name);
      return callee.type === "MemberExpression" && browserMethods.has(staticKey(callee));
    };
    const pageOwned = (node, receiver) => {
      for (let at = node.parent; at; at = at.parent) {
        if (!browserTask(at)) continue;
        const base = root(receiver);
        if (base?.type !== "Identifier") return true;
        const defs = binding(base)?.defs ?? [];
        if (defs.length) return defs.every((definition) => within(definition.name, at));
        return pageGlobals.has(base.name) || receiver.type === "NewExpression";
      }
      return false;
    };
    const ownProcess = (receiver) => receiver?.type === "Identifier" && receiver.name === "process" &&
      !binding(receiver)?.defs.length;
    const check = (node, receiver) => {
      if (receiver?.type === "Super" || ownProcess(receiver) || pageOwned(node, receiver)) return;
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
