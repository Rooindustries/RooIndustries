import { ancestors, attribute, declaredValue, jsxName, propertyName, resolveOnce } from "./util.mjs";

const keyValue = (key) =>
  resolveOnce(null, (context, node, next) => {
    if (node.type === "Identifier") return next(declaredValue(context, node));
    if (node.type !== "ObjectExpression") return null;
    let value = null;
    for (const property of node.properties) {
      if (property.type === "SpreadElement") value = next(property.argument) ?? value;
      else if (propertyName(property) === key) value = property.value;
    }
    return value;
  });

const finalValue = (context, node, key) => keyValue(key)(context, node);

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
