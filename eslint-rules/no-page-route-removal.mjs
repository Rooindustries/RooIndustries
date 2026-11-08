import { constValue } from "./util.mjs";

const removals = new Set(["unroute", "unrouteAll"]);
const staticName = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node.type === "Identifier") return staticName(context, constValue(context, node), seen);
  return null;
};

export default {
  meta: {
    type: "problem",
    docs: { description: "Keep route removal inside the shared context-routing helper." },
    messages: { removal: "Use the shared context-routing helper so requests keep one route owner." },
    schema: [],
  },
  create(context) {
    const check = (node, property, computed) => {
      const name = computed ? staticName(context, property) : property.name;
      if (removals.has(name)) context.report({ node, messageId: "removal" });
    };
    return {
      MemberExpression(node) {
        check(node, node.property, node.computed);
      },
      Property(node) {
        if (node.parent.type === "ObjectPattern") {
          check(node, node.key, node.computed || node.key.type === "Literal");
        }
      },
    };
  },
};
