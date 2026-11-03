import { ancestors, attribute, declaredValue, jsxName, propertyName } from "./util.mjs";

const finalValue = (context, node, key, seen = new Set()) => {
  if (!node || seen.has(node)) return null;
  const path = new Set(seen).add(node);
  if (node.type === "Identifier") return finalValue(context, declaredValue(context, node), key, path);
  if (node.type !== "ObjectExpression") return null;
  let value = null;
  for (const property of node.properties) {
    if (property.type === "SpreadElement") value = finalValue(context, property.argument, key, path) ?? value;
    else if (propertyName(property) === key) value = property.value;
  }
  return value;
};

const hidesOpacity = (context, node) => {
  const opacity = finalValue(context, node, "opacity");
  return opacity?.type === "Literal" && opacity.value === 0;
};

const variantObject = (context, variantsAttr, key) =>
  variantsAttr?.value?.type === "JSXExpressionContainer"
    ? finalValue(context, variantsAttr.value.expression, key)
    : null;

const mountedConditionally = (context, node) =>
  ancestors(context, node).some(
    (item) =>
      (item.type === "LogicalExpression" && item.operator === "&&") ||
      item.type === "ConditionalExpression",
  );

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Server-rendered content must not start invisible and wait for JavaScript to fade in.",
    },
    messages: {
      hidden:
        "This element starts at opacity 0 until JavaScript runs, so server-rendered content stays " +
        "invisible. Start it visible.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (!jsxName(node.name).startsWith("motion.")) return;
        const initial = attribute(node, "initial");
        if (!initial?.value) return;
        let hidden = false;
        if (initial.value.type === "JSXExpressionContainer") {
          hidden = hidesOpacity(context, initial.value.expression);
        } else if (initial.value.type === "Literal" && typeof initial.value.value === "string") {
          hidden = hidesOpacity(context, variantObject(context, attribute(node, "variants"), initial.value.value));
        }
        if (hidden && !mountedConditionally(context, node.parent))
          context.report({ node, messageId: "hidden" });
      },
    };
  },
};
