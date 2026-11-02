import { ancestors, jsxName } from "./util.mjs";

const lowContrastBackgrounds = new Set(["bg-accent-strong", "bg-accent", "bg-danger", "bg-purple-500"]);

export default {
  meta: {
    type: "problem",
    docs: { description: "White text on these brand backgrounds fails WCAG contrast." },
    messages: {
      contrast: "text-white on {{background}} fails contrast. Use the matching contrast colour instead.",
    },
    schema: [],
  },
  create(context) {
    const check = (node, text) => {
      const tokens = new Set(String(text).split(/\s+/));
      if (!tokens.has("text-white")) return;
      const background = [...tokens].find((token) => lowContrastBackgrounds.has(token));
      if (background) context.report({ node, messageId: "contrast", data: { background } });
    };
    const insideClassName = (node) =>
      ancestors(context, node).some(
        (item) => item.type === "JSXAttribute" && jsxName(item.name) === "className",
      );
    return {
      Literal(node) {
        if (typeof node.value === "string" && insideClassName(node)) check(node, node.value);
      },
      TemplateLiteral(node) {
        if (insideClassName(node)) check(node, node.quasis.map((quasi) => quasi.value.cooked).join(" "));
      },
    };
  },
};
