export default {
  meta: {
    type: "problem",
    docs: { description: "Prices built as `$${amount}` ignore the payment currency and its formatting." },
    messages: {
      dollars:
        'This builds a price by putting "$" in front of a number. Format it with the payment\'s currency instead.',
    },
    schema: [],
  },
  create(context) {
    return {
      TemplateLiteral(node) {
        node.expressions.forEach((expression, index) => {
          if (/\$$/.test(node.quasis[index].value.cooked || "")) {
            context.report({ node: expression, messageId: "dollars" });
          }
        });
      },
    };
  },
};
