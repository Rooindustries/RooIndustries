const pathLike = (node) => {
  if (node.type === "Identifier") return /path/i.test(node.name);
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return /path/i.test(node.property.name);
  }
  return false;
};

export default {
  meta: {
    type: "problem",
    docs: { description: 'startsWith("/booking") also matches /bookings-help and similar routes.' },
    messages: {
      prefix:
        'startsWith("{{prefix}}") also matches other routes that share the prefix. Compare the exact path ' +
        'or use "{{prefix}}/".',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed || callee.property.name !== "startsWith")
          return;
        if (!pathLike(callee.object)) return;
        const [prefix] = node.arguments;
        if (prefix?.type !== "Literal" || typeof prefix.value !== "string") return;
        if (prefix.value.length > 1 && prefix.value.startsWith("/") && !prefix.value.endsWith("/")) {
          context.report({ node, messageId: "prefix", data: { prefix: prefix.value } });
        }
      },
    };
  },
};
