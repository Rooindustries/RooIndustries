import { calleeName, propertyName } from "./util.mjs";

const SCROLL_CALLS = new Set(["scroll", "scrollTo", "scrollBy", "scrollIntoView"]);
const POSITIONAL_CALLS = new Set(["scroll", "scrollTo", "scrollBy"]);
const SAFE_BEHAVIORS = new Set(["auto", "instant"]);
const HELPER_MODULE = "/src/lib/scrollCoordinator.js";

const staticString = (node) => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
};

const isSafeOptions = (node) => {
  if (node.type !== "ObjectExpression") return false;
  if (node.properties.some((item) => item.type !== "Property" || item.computed)) return false;
  const behavior = node.properties.findLast((item) => propertyName(item) === "behavior");
  return !behavior || (behavior.kind === "init" && SAFE_BEHAVIORS.has(staticString(behavior.value)));
};

const isSafeArgument = (name, node) => {
  if (node.type === "Literal" && typeof node.value === "number") return true;
  if (name === "scrollIntoView" && node.type === "Literal" && typeof node.value === "boolean") return true;
  return isSafeOptions(node);
};

const isSafeCall = (name, args) => {
  if (args.some((item) => item.type === "SpreadElement")) return false;
  if (args.length === 0) return true;
  if (POSITIONAL_CALLS.has(name) && args.length >= 2) return true;
  return isSafeArgument(name, args[0]);
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "A scroll whose behavior can't be read from the call may animate for visitors who asked for reduced motion.",
    },
    messages: {
      unchecked:
        "This scroll may animate even when the visitor asked for reduced motion. Use scrollWindowTo from " +
        'src/lib/scrollCoordinator, or pass a plain object literal whose behavior is "auto" or "instant".',
    },
    schema: [],
  },
  create(context) {
    if (context.filename.replaceAll("\\", "/").endsWith(HELPER_MODULE)) return {};
    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (!SCROLL_CALLS.has(name) || isSafeCall(name, node.arguments)) return;
        context.report({ node, messageId: "unchecked" });
      },
    };
  },
};
