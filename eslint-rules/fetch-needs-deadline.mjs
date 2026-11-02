const isFetch = (callee) =>
  (callee.type === "Identifier" && callee.name === "fetch") ||
  (callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.name === "fetch" &&
    callee.object.type === "Identifier" &&
    ["window", "globalThis", "self"].includes(callee.object.name));

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
        if (!isFetch(node.callee)) return;
        const options = node.arguments[1];
        if (!options) return context.report({ node, messageId: "missing" });
        if (options.type !== "ObjectExpression") return;
        const hasSignal = options.properties.some(
          (property) =>
            property.type === "SpreadElement" ||
            (property.type === "Property" &&
              !property.computed &&
              ((property.key.type === "Identifier" && property.key.name === "signal") ||
                (property.key.type === "Literal" && property.key.value === "signal"))),
        );
        if (!hasSignal) context.report({ node, messageId: "missing" });
      },
    };
  },
};
