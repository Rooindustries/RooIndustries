export default {
  meta: {
    type: "problem",
    schema: [],
    messages: { scoped: "Read and clear payment sessions through paymentSessionStorage so they match the booking." },
  },
  create(context) {
    if (context.filename.replaceAll("\\", "/").endsWith("/src/lib/paymentSessionStorage.js")) return {};
    const report = node => context.report({ node, messageId: "scoped" });
    return {
      Literal(node) {
        if (node.value === "payment_session_state") report(node);
      },
      TemplateLiteral(node) {
        if (!node.expressions.length && node.quasis[0].value.cooked === "payment_session_state") report(node);
      },
    };
  },
};
