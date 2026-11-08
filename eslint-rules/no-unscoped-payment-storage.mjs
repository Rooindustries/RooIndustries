export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      scoped: "Read and change checkout choices through checkout-state so failed saves cannot restore older values.",
    },
  },
  create(context) {
    if (context.filename.replaceAll("\\", "/").endsWith("/public/checkout-state.js")) return {};
    const keys = new Set(["booking_draft", "checkout_booking_state", "payment_session_state", "referral_session"]);
    const report = node => context.report({ node, messageId: "scoped" });
    return {
      Literal(node) {
        if (keys.has(node.value)) report(node);
      },
      TemplateLiteral(node) {
        if (!node.expressions.length && keys.has(node.quasis[0].value.cooked)) report(node);
      },
    };
  },
};
