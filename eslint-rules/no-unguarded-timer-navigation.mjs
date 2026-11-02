import { calleeName, enclosingComponent, isFunction } from "./util.mjs";

const navigates = (call) =>
  ["nav", "navigate", "push", "replace"].includes(calleeName(call)) &&
  (call.callee.type === "Identifier" || calleeName(call) === "push" || calleeName(call) === "replace");

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
        if (topLevelCalls(callback).some((inner) => navigates(inner) || resetsState(inner))) {
          context.report({ node, messageId: "timer" });
        }
      },
    };
  },
};
