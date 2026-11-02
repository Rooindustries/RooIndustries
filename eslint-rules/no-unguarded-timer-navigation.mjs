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

const declaredRouter = (context, identifier) => {
  let variable = null;
  for (let scope = context.sourceCode.getScope(identifier); scope && !variable; scope = scope.upper) {
    variable = scope.set.get(identifier.name) || null;
  }
  const declaration = variable?.defs?.[0]?.node;
  if (!declaration) return null;
  const init = declaration.init;
  return init?.type === "CallExpression" && ROUTER_HOOKS.has(calleeName(init));
};

const isRouterReceiver = (context, callee) => {
  if (callee.object.type === "Identifier") {
    const declared = declaredRouter(context, callee.object);
    if (declared !== null) return declared;
  }
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
