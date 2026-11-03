import { isFetchCall, isFunction, propertyName, resolveOnce, UNKNOWN, unchangedValue } from "./util.mjs";

const usesResponse = (context, handler) => {
  if (!handler) return false;
  if (!isFunction(handler)) return true;
  const [response] = handler.params;
  if (!response) return false;
  if (response.type !== "Identifier") return true;
  const variable = context.sourceCode
    .getDeclaredVariables(handler)
    .find((item) => item.name === response.name);
  return Boolean(variable?.references.length);
};

const unwrap = (context, expression) => {
  let current = expression;
  for (;;) {
    if (current.type === "AwaitExpression") current = current.argument;
    else if (
      current.type === "CallExpression" &&
      current.callee.type === "MemberExpression" &&
      !current.callee.computed &&
      ["catch", "finally", "then"].includes(current.callee.property.name)
    ) {
      if (current.callee.property.name === "then" && usesResponse(context, current.arguments[0]))
        return current;
      current = current.callee.object;
    } else return current;
  }
};

const methodValue = resolveOnce(UNKNOWN, (context, node, next) => {
  if (node.type === "Identifier") return next(unchangedValue(context, node));
  if (node.type !== "ObjectExpression") return UNKNOWN;
  let value;
  for (const property of node.properties) {
    if (property.type === "SpreadElement") {
      const spread = next(property.argument);
      if (spread !== undefined) value = spread;
    } else if (propertyName(property) === "method") {
      value = property.value.type === "Literal" ? String(property.value.value).toUpperCase() : UNKNOWN;
    }
  }
  return value;
});

const writeMethod = (context, call) => {
  const value = methodValue(context, call.arguments[1]);
  return typeof value === "string" && value !== "GET" && value !== "HEAD" ? value : null;
};

export default {
  meta: {
    type: "problem",
    docs: { description: "A write request whose result is ignored lets the UI move on as if it worked." },
    messages: {
      ignored: "The result of this {{method}} request is ignored. Check the response before updating the UI.",
    },
    schema: [],
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        const call = unwrap(context, node.expression);
        if (call.type !== "CallExpression" || !isFetchCall(call)) return;
        const method = writeMethod(context, call);
        if (method) context.report({ node, messageId: "ignored", data: { method } });
      },
    };
  },
};
