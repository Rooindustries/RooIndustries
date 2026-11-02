import { attribute } from "./util.mjs";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "A disclosure toggle must point at the content it shows.",
    },
    messages: { controls: "aria-expanded needs aria-controls pointing at the content it shows or hides." },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (attribute(node, "aria-expanded") && !attribute(node, "aria-controls")) {
          context.report({ node, messageId: "controls" });
        }
      },
    };
  },
};
