export default {
  meta: { type: "problem", schema: [], messages: {
    cache: "Use checkoutRecovery to store payment sessions with a resumable payload.",
  } },
  create(context) {
    if (context.filename.replaceAll("\\", "/").endsWith("/src/lib/checkoutRecovery.js")) return {};
    return {
      Literal(node) {
        if (node.value === "payment_session_state") context.report({ node, messageId: "cache" });
      },
      TemplateLiteral(node) {
        if (!node.expressions.length && node.quasis[0].value.cooked === "payment_session_state") {
          context.report({ node, messageId: "cache" });
        }
      },
    };
  },
};
