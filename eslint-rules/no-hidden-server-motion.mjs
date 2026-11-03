import { ancestors, attribute, jsxName } from "./util.mjs";

const hidesOpacity = (object) =>
  object?.type === "ObjectExpression" &&
  object.properties.some(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" && property.key.name === "opacity") ||
        (property.key.type === "Literal" && property.key.value === "opacity")) &&
      property.value.type === "Literal" &&
      property.value.value === 0,
  );

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
  if (object?.type !== "ObjectExpression") return null;
  const entry = object.properties.find(
    (property) =>
      property.type === "Property" &&
      !property.computed &&
      ((property.key.type === "Identifier" && property.key.name === key) ||
        (property.key.type === "Literal" && property.key.value === key)),
  );
  return entry?.value || null;
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
