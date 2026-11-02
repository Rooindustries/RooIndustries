import { declaredValue, isFetchCall } from "./util.mjs";

const isSignalKey = (property) =>
  property.type === "Property" &&
  !property.computed &&
  ((property.key.type === "Identifier" && property.key.name === "signal") ||
    (property.key.type === "Literal" && property.key.value === "signal"));

const carriesSignal = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return true;
  seen.add(node);
  if (node.type === "Identifier") {
    const value = declaredValue(context, node);
    return value ? carriesSignal(context, value, seen) : true;
  }
  if (node.type !== "ObjectExpression") return true;
  return node.properties.some(
    (property) =>
      isSignalKey(property) ||
      (property.type === "SpreadElement" && carriesSignal(context, property.argument, seen)),
  );
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Every fetch needs an AbortSignal so a stalled request can't hang the page or the server.",
    },
    messages: {
      missing: "Pass a signal (for example AbortSignal.timeout(ms)) so this request has a deadline.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isFetchCall(node)) return;
        const options = node.arguments[1];
        if (!options || !carriesSignal(context, options)) context.report({ node, messageId: "missing" });
      },
    };
  },
};
