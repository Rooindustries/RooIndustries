import { attribute, jsxName, literalValue } from "./util.mjs";

const unnamedRoles = new Set([
  "",
  "caption",
  "code",
  "deletion",
  "emphasis",
  "generic",
  "insertion",
  "none",
  "paragraph",
  "presentation",
  "strong",
  "subscript",
  "superscript",
]);

const UNKNOWN = Symbol("unknown role");

const effectiveRole = (node) => {
  let role = null;
  for (const item of node.attributes) {
    if (item.type === "JSXSpreadAttribute") role = UNKNOWN;
    else if (item.name.type === "JSXIdentifier" && item.name.name === "role") {
      const value = literalValue(item);
      role = typeof value === "string" ? value : UNKNOWN;
    }
  }
  return role;
};

const hasNameableRole = (node) => {
  const role = effectiveRole(node);
  if (role === UNKNOWN) return true;
  if (role === null) return false;
  const firstToken = role.trim().toLowerCase().split(/\s+/)[0];
  return !unnamedRoles.has(firstToken);
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
