import { ancestors, attribute, jsxName, propertyName } from "./util.mjs";

const finalValue = (object, key) =>
  object?.type === "ObjectExpression"
    ? (object.properties.findLast((property) => propertyName(property) === key)?.value ?? null)
    : null;

const hidesOpacity = (object) => {
  const opacity = finalValue(object, "opacity");
  return opacity?.type === "Literal" && opacity.value === 0;
};

const variantObject = (context, node, variantsAttr, key) => {
  const expression =
    variantsAttr?.value?.type === "JSXExpressionContainer" ? variantsAttr.value.expression : null;
  let object = expression;
  if (expression?.type === "Identifier") {
    object = null;
    for (let scope = context.sourceCode.getScope(node); scope && !object; scope = scope.upper) {
      const definition = scope.set.get(expression.name)?.defs[0]?.node;
      if (definition?.type === "VariableDeclarator") object = definition.init;
    }
  }
  return finalValue(object, key);
};

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
          hidden = hidesOpacity(initial.value.expression);
        } else if (initial.value.type === "Literal" && typeof initial.value.value === "string") {
          hidden = hidesOpacity(
            variantObject(context, node, attribute(node, "variants"), initial.value.value),
          );
        }
        if (hidden && !mountedConditionally(context, node.parent))
          context.report({ node, messageId: "hidden" });
      },
    };
  },
};
