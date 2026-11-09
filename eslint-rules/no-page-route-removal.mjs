import { bindingDefinition, constValue } from "./util.mjs";

const removals = new Set(["unroute", "unrouteAll"]);
const staticName = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node.type === "Identifier") return staticName(context, constValue(context, node), seen);
  return null;
};

const browserTarget = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === "Identifier") {
    const value = constValue(context, node);
    if (value) return browserTarget(context, value, seen);
    const definition = bindingDefinition(context, node);
    const property = definition?.type === "Parameter" ? definition.name.parent : null;
    return ["page", "context"].includes(node.name) ||
      (property?.type === "Property" && ["page", "context"].includes(property.key.name));
  }
  if (node.type === "AwaitExpression") return browserTarget(context, node.argument, seen);
  return node.type === "CallExpression" && node.callee.type === "MemberExpression" &&
    ["context", "newPage", "newContext"].includes(node.callee.property.name);
};

export default {
  meta: {
    type: "problem",
    docs: { description: "Keep route removal inside the shared context-routing helper." },
    messages: { removal: "Use the shared context-routing helper so requests keep one route owner." },
    schema: [],
  },
  create(context) {
    const check = (node, property, computed, target) => {
      const name = computed ? staticName(context, property) : property.name;
      if (removals.has(name) && browserTarget(context, target)) context.report({ node, messageId: "removal" });
    };
    return {
      MemberExpression(node) {
        check(node, node.property, node.computed, node.object);
      },
      Property(node) {
        if (node.parent.type === "ObjectPattern" && node.parent.parent.type === "VariableDeclarator") {
          check(node, node.key, node.computed || node.key.type === "Literal", node.parent.parent.init);
        }
      },
      Identifier(node) {
        if (node.name === "removeContextRoutes" && node.parent.type !== "Property") {
          context.report({ node, messageId: "removal" });
        }
      },
    };
  },
};
