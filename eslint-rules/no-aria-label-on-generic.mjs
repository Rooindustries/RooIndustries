import { attribute, jsxName, literalValue } from "./util.mjs";

const unnamedRoles = new Set(["", "generic", "none", "presentation", "paragraph"]);

const hasNameableRole = (node) => {
  const role = attribute(node, "role");
  if (!role) return false;
  const value = literalValue(role);
  return typeof value !== "string" || !unnamedRoles.has(value.trim().toLowerCase());
};

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
        if (attribute(node, "aria-label") && !hasNameableRole(node)) {
          context.report({ node, messageId: "generic", data: { name } });
        }
      },
    };
  },
};
