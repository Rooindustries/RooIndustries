import { calleeName, enclosingComponent, isFunction } from "./util.mjs";

const ROUTER_OBJECTS = new Set(["router", "history", "location"]);
const ROUTER_HOOKS = new Set(["useRouter", "useHistory"]);

const receiverName = (callee) => {
  if (callee.type !== "MemberExpression" || callee.computed) return "";
  const receiver = callee.object;
  if (receiver.type === "Identifier") return receiver.name;
  if (receiver.type === "MemberExpression" && !receiver.computed) return receiver.property.name;
  return "";
};

const UNKNOWN_SOURCES = new Set([
  "ChainExpression",
  "AwaitExpression",
  "ConditionalExpression",
  "LogicalExpression",
]);

const declaredValue = (context, identifier) => {
  let variable = null;
  for (let scope = context.sourceCode.getScope(identifier); scope && !variable; scope = scope.upper) {
    variable = scope.set.get(identifier.name) || null;
  }
  const definition = variable?.defs?.[0];
  if (!definition || definition.type !== "Variable" || definition.node.id.type !== "Identifier") return null;
  return definition.node.init || null;
};

const propertyValue = (object, name) => {
  const property = object.properties.find(
    (item) => item.type === "Property" && !item.computed && (item.key.name || item.key.value) === name,
  );
  return property ? property.value : null;
};

const routerValue = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.type === "Identifier") return routerValue(context, declaredValue(context, node), seen);
  if (node.type === "MemberExpression") {
    if (node.computed || node.property.type !== "Identifier") return null;
    const owner = node.object.type === "Identifier" ? declaredValue(context, node.object) : null;
    if (owner?.type !== "ObjectExpression") return null;
    return routerValue(context, propertyValue(owner, node.property.name), seen);
  }
  if (UNKNOWN_SOURCES.has(node.type)) return null;
  return node.type === "CallExpression" && ROUTER_HOOKS.has(calleeName(node));
};

const isRouterReceiver = (context, callee) => {
  const known = routerValue(context, callee.object);
  if (known !== null) return known;
  return ROUTER_OBJECTS.has(receiverName(callee));
};

const navigates = (context, call) => {
  const name = calleeName(call);
  if (call.callee.type === "Identifier") return name === "nav" || name === "navigate";
  if (name !== "push" && name !== "replace") return false;
  return (
    call.callee.type === "MemberExpression" && !call.callee.computed && isRouterReceiver(context, call.callee)
  );
};

const resetsState = (call) =>
  call.callee.type === "Identifier" &&
  /^set[A-Z]/.test(call.callee.name) &&
  call.arguments.length === 1 &&
  call.arguments[0].type === "Literal";

const topLevelCalls = (fn) => {
  if (fn.body.type === "CallExpression") return [fn.body];
  if (fn.body.type !== "BlockStatement") return [];
  return fn.body.body
    .filter(
      (statement) =>
        statement.type === "ExpressionStatement" && statement.expression.type === "CallExpression",
    )
    .map((statement) => statement.expression);
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "A discarded timer that navigates or resets state fires after the component moved on.",
    },
    messages: {
      timer:
        "This timer can't be cancelled and changes state after the component may have moved on. Keep its id " +
        "and clear it on cleanup, or guard the callback.",
    },
    schema: [],
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const call = node.expression;
        if (call.type !== "CallExpression" || calleeName(call) !== "setTimeout") return;
        const callback = call.arguments[0];
        if (!isFunction(callback)) return;
        if (!enclosingComponent(context, node)) return;
        if (topLevelCalls(callback).some((inner) => navigates(context, inner) || resetsState(inner))) {
          context.report({ node, messageId: "timer" });
        }
      },
    };
  },
};
