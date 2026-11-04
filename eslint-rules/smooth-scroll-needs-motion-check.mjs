import { calleeName, propertyName } from "./util.mjs";

const SCROLL_CALLS = new Set(["scroll", "scrollTo", "scrollBy", "scrollIntoView"]);
const MOTION_CHECKS = new Set(["prefersReducedMotion"]);

const findVariable = (context, identifier) => {
  for (let scope = context.sourceCode.getScope(identifier); scope; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable) return variable;
  }
  return null;
};

const boundValues = (context, identifier) => {
  const definition = findVariable(context, identifier)?.defs?.[0];
  if (!definition) return [];
  if (definition.type === "Variable" && definition.node.id.type === "Identifier") {
    return definition.node.init ? [definition.node.init] : [];
  }
  if (definition.type === "Parameter" && definition.name.parent?.type === "AssignmentPattern") {
    return [definition.name.parent.right];
  }
  return [];
};

const isMotionCheck = (node) => node?.type === "CallExpression" && MOTION_CHECKS.has(calleeName(node));

const mightBeSmooth = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === "Literal") return node.value === "smooth";
  if (node.type === "TemplateLiteral") {
    return node.expressions.length === 0 && node.quasis[0].value.cooked === "smooth";
  }
  if (node.type === "ConditionalExpression") {
    if (isMotionCheck(node.test)) return mightBeSmooth(context, node.consequent, seen);
    return mightBeSmooth(context, node.consequent, seen) || mightBeSmooth(context, node.alternate, seen);
  }
  if (node.type === "LogicalExpression") {
    return mightBeSmooth(context, node.left, seen) || mightBeSmooth(context, node.right, seen);
  }
  if (node.type === "Identifier") {
    return boundValues(context, node).some((value) => mightBeSmooth(context, value, seen));
  }
  return false;
};

const optionObjects = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return [];
  seen.add(node);
  if (node.type === "ObjectExpression") return [node];
  if (node.type === "Identifier") {
    return boundValues(context, node).flatMap((value) => optionObjects(context, value, seen));
  }
  return [];
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "A smooth scroll animates for visitors who asked their system for reduced motion.",
    },
    messages: {
      smooth:
        "This scroll animates even when the visitor asked for reduced motion. Use scrollWindowTo from " +
        "src/lib/scrollCoordinator, or pick the behavior with prefersReducedMotion() first.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!SCROLL_CALLS.has(calleeName(node))) return;
        for (const argument of node.arguments) {
          for (const options of optionObjects(context, argument)) {
            const behavior = options.properties.find((item) => propertyName(item) === "behavior");
            if (behavior && mightBeSmooth(context, behavior.value)) {
              context.report({ node: behavior, messageId: "smooth" });
            }
          }
        }
      },
    };
  },
};
