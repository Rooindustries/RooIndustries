import { attribute, jsxName } from "./util.mjs";

export default {
  meta: {
    type: "problem",
    docs: { description: "aria-label on a div, span or p without a role is ignored by screen readers." },
    messages: {
      generic:
        "aria-label on a <{{name}}> without a role is ignored. Give it a role or use visible or sr-only text.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        const name = jsxName(node.name);
        if (!["div", "span", "p"].includes(name)) return;
        if (attribute(node, "aria-label") && !attribute(node, "role")) {
          context.report({ node, messageId: "generic", data: { name } });
        }
      },
    };
  },
};
