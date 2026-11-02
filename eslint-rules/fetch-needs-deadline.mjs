import { declaredValue, isFetchCall } from "./util.mjs";

const isSignalKey = (property) =>
  property.type === "Property" &&
  !property.computed &&
  ((property.key.type === "Identifier" && property.key.name === "signal") ||
    (property.key.type === "Literal" && property.key.value === "signal"));

const clearsSignal = (value) =>
  (value.type === "Literal" && value.value === null) ||
  (value.type === "Identifier" && value.name === "undefined");

const signalState = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return "unknown";
  seen.add(node);
  if (node.type === "Identifier") {
    const value = declaredValue(context, node);
    return value ? signalState(context, value, seen) : "unknown";
  }
  if (node.type !== "ObjectExpression") return "unknown";
  let state = "none";
  for (const property of node.properties) {
    if (isSignalKey(property)) state = clearsSignal(property.value) ? "cleared" : "set";
    else if (property.type === "SpreadElement") {
      const spread = signalState(context, property.argument, seen);
      if (spread !== "none") state = spread;
    }
  }
  return state;
};

const carriesSignal = (context, node) => ["set", "unknown"].includes(signalState(context, node));

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
