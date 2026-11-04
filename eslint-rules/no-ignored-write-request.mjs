import { declaredValue, isFetchCall, isFunction, propertyName } from "./util.mjs";

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

const methodValue = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.type === "Identifier") return methodValue(context, declaredValue(context, node), seen);
  if (node.type !== "ObjectExpression") return null;
  let value = null;
  for (const property of node.properties) {
    if (property.type === "SpreadElement") value = methodValue(context, property.argument, seen) ?? value;
    else if (propertyName(property) === "method") {
      value = property.value.type === "Literal" ? String(property.value.value).toUpperCase() : null;
    }
  }
  return value;
};

const writeMethod = (context, call) => {
  const value = methodValue(context, call.arguments[1]);
  return value && value !== "GET" && value !== "HEAD" ? value : null;
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
