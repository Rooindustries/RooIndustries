import { attribute, jsxName, literalValue } from "./util.mjs";

const ariaRoles = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote", "button", "caption", "cell",
  "checkbox", "code", "columnheader", "combobox", "comment", "complementary", "contentinfo", "definition",
  "deletion", "dialog", "directory", "document", "emphasis", "feed", "figure", "form", "generic", "grid",
  "gridcell", "group", "heading", "image", "img", "insertion", "link", "list", "listbox", "listitem", "log",
  "main", "mark", "marquee", "math", "menu", "menubar", "menuitem", "menuitemcheckbox", "menuitemradio",
  "meter", "navigation", "none", "note", "option", "paragraph", "presentation", "progressbar", "radio",
  "radiogroup", "region", "row", "rowgroup", "rowheader", "scrollbar", "search", "searchbox", "separator",
  "slider", "spinbutton", "status", "strong", "subscript", "suggestion", "superscript", "switch", "tab",
  "table", "tablist", "tabpanel", "term", "textbox", "time", "timer", "toolbar", "tooltip", "tree",
  "treegrid", "treeitem",
]);

const unnamedRoles = new Set([
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

const absentValue = (expression) =>
  (expression.type === "Literal" && (expression.value === null || expression.value === false)) ||
  (expression.type === "Identifier" && expression.name === "undefined");

const roleValue = (attr) => {
  if (attr.value?.type === "JSXExpressionContainer" && absentValue(attr.value.expression)) return null;
  const value = literalValue(attr);
  return typeof value === "string" ? value : UNKNOWN;
};

const effectiveRole = (node) => {
  let role = null;
  for (const item of node.attributes) {
    if (item.type === "JSXSpreadAttribute") role = UNKNOWN;
    else if (item.name.type === "JSXIdentifier" && item.name.name === "role") role = roleValue(item);
  }
  return role;
};

const hasNameableRole = (node) => {
  const role = effectiveRole(node);
  if (role === UNKNOWN) return true;
  if (role === null) return false;
  const recognized = role.trim().toLowerCase().split(/\s+/).find((token) => ariaRoles.has(token));
  return Boolean(recognized) && !unnamedRoles.has(recognized);
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
