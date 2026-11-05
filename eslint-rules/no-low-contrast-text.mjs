import { ancestors, jsxName } from "./util.mjs";

const lowContrastBackgrounds = new Set(["bg-accent-strong", "bg-accent", "bg-danger", "bg-success", "bg-purple-500"]);
const MAX_CLASS_COMBINATIONS = 64;

const classOptions = (node) => {
  if (node.type === "Literal") return typeof node.value === "string" ? [node.value] : [""];
  if (node.type === "ConditionalExpression")
    return [...classOptions(node.consequent), ...classOptions(node.alternate)];
  if (node.type === "LogicalExpression" && node.operator === "&&") return ["", ...classOptions(node.right)];
  if (node.type === "LogicalExpression") return [...classOptions(node.left), ...classOptions(node.right)];
  if (node.type === "TemplateLiteral") return templateOptions(node);
  return [""];
};

const templateOptions = (node) => {
  let combinations = [node.quasis[0].value.cooked];
  node.expressions.forEach((expression, index) => {
    const tail = node.quasis[index + 1].value.cooked;
    const options = classOptions(expression);
    combinations = combinations
      .flatMap((prefix) => options.map((option) => `${prefix} ${option} ${tail}`))
      .slice(0, MAX_CLASS_COMBINATIONS);
  });
  return combinations;
};

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
    const lowContrastBackground = (text) => {
      const tokens = new Set(String(text).split(/\s+/));
      if (!tokens.has("text-white")) return "";
      return [...tokens].find((token) => lowContrastBackgrounds.has(token)) || "";
    };
    const check = (node, texts) => {
      const background = texts.map(lowContrastBackground).find(Boolean);
      if (background) context.report({ node, messageId: "contrast", data: { background } });
    };
    const insideTemplate = (node) => ancestors(context, node).some((item) => item.type === "TemplateLiteral");
    const insideClassName = (node) =>
      ancestors(context, node).some(
        (item) => item.type === "JSXAttribute" && jsxName(item.name) === "className",
      );
    return {
      Literal(node) {
        if (typeof node.value === "string" && insideClassName(node) && !insideTemplate(node))
          check(node, [node.value]);
      },
      TemplateLiteral(node) {
        if (insideClassName(node) && !insideTemplate(node)) check(node, templateOptions(node));
      },
    };
  },
};
