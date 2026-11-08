const observers = new Set([
  "MutationObserver", "ResizeObserver", "IntersectionObserver", "PerformanceObserver", "ReportingObserver",
]);
const globalObjects = new Set(["globalThis", "window", "self", "global", "top", "parent", "frames"]);
const staticKey = (node) => {
  const key = node.property ?? node.key;
  if (!node.computed && key.type === "Identifier") return key.name;
  if (key.type === "Literal" && typeof key.value === "string") return key.value;
  if (key.type === "TemplateLiteral" && !key.expressions.length) return key.quasis[0].value.cooked;
};
const isWriteTarget = (node) => {
  const { parent } = node;
  if (["AssignmentExpression", "ForOfStatement", "ForInStatement"].includes(parent.type)) return parent.left === node;
  if (parent.type === "UpdateExpression") return parent.argument === node;
  if (parent.type === "UnaryExpression") return parent.operator === "delete";
  if (parent.type === "ChainExpression") return isWriteTarget(parent);
  if (parent.type === "Property") {
    return parent.value === node && parent.parent.type === "ObjectPattern" && isWriteTarget(parent.parent);
  }
  if (parent.type === "AssignmentPattern") return parent.left === node && isWriteTarget(parent);
  if (["ArrayPattern", "RestElement"].includes(parent.type)) return isWriteTarget(parent);
  return false;
};
const ownValue = ({ identifier }) => {
  const { parent } = identifier;
  if (parent.type === "VariableDeclarator" && parent.id === identifier) {
    return ["ForOfStatement", "ForInStatement"].includes(parent.parent.parent?.type) ? false : parent.init;
  }
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
    const globalScope = context.sourceCode.scopeManager.globalScope;
    const references = [
      ...globalScope.through,
      ...globalScope.variables.filter((binding) => !binding.defs.length).flatMap((binding) => binding.references),
    ];
    const globalWrites = new Set(references.filter((reference) => reference.isWrite())
      .map((reference) => reference.identifier.name));
    let globalShared = false;
    for (const { identifier } of references.filter((reference) => globalObjects.has(reference.identifier.name))) {
      let target = identifier;
      while (target.parent.type === "MemberExpression" && target.parent.object === target &&
        globalObjects.has(staticKey(target.parent))) target = target.parent;
      const { parent } = target;
      if (parent.type === "UnaryExpression" && parent.operator !== "delete") continue;
      if (parent.type === "BinaryExpression") continue;
      const member = parent.type === "MemberExpression" && parent.object === target;
      if (member && !isWriteTarget(parent)) continue;
      const key = member ? staticKey(parent) : undefined;
      if (typeof key === "string") globalWrites.add(key);
      else globalShared = true;
    }
    const variable = (node) => {
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        if (scope.set.has(node.name)) return scope.set.get(node.name);
      }
    };
    const observer = (node) => node?.type === "NewExpression" && node.callee.type === "Identifier" &&
      observers.has(node.callee.name) && !variable(node.callee)?.defs.length && !globalWrites.has(node.callee.name) &&
      !globalShared;
    const constructed = (node) => {
      if (node?.type === "NewExpression") return observer(node);
      if (node?.type !== "Identifier") return false;
      const binding = variable(node);
      if (!binding) return false;
      const values = binding.references.filter((reference) => reference.isWrite()).map(ownValue);
      if (values.includes(false) || !binding.defs.every((definition) => definition.type === "Variable")) return false;
      const held = values.filter((value) => !isEmpty(value));
      return held.length > 0 && held.every(observer);
    };
    const check = (node, receiver) => {
      if (receiver?.type === "Identifier" && receiver.name === "process") return;
      if (receiver?.type === "Super" || constructed(receiver)) return;
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
