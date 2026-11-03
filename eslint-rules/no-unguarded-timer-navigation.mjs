import { calleeName, declaredValue, enclosingComponent, isFunction } from "./util.mjs";

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

const propertyValue = (object, name) => {
  let value = null;
  for (const item of object.properties) {
    if (item.type !== "Property" || item.computed) value = null;
    else if ((item.key.name || item.key.value) === name) value = item.value;
  }
  return value;
};

const routerValue = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return null;
  const path = new Set(seen).add(node);
  if (node.type === "Identifier") return routerValue(context, declaredValue(context, node), path);
  if (node.type === "MemberExpression") {
    if (node.computed || node.property.type !== "Identifier") return null;
    const owner = node.object.type === "Identifier" ? declaredValue(context, node.object) : null;
    if (owner?.type !== "ObjectExpression") return null;
    return routerValue(context, propertyValue(owner, node.property.name), path);
  }
  if (UNKNOWN_SOURCES.has(node.type)) return null;
  if (node.type === "CallExpression") return ROUTER_HOOKS.has(calleeName(node)) ? true : null;
  return false;
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
