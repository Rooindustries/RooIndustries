import { constValue } from "./util.mjs";

const recordingOptions = new Set(["trace", "video"]);

const keyName = (context, node, computed, seen = new Set()) => {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal") return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node.type !== "Identifier" || seen.has(node)) return null;
  seen.add(node);
  const value = constValue(context, node);
  return value ? keyName(context, value, true, seen) : null;
};

export default {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      recording: "Keep trace and video options in playwright.config.js so stalled tests retain their recordings.",
    },
  },
  create(context) {
    return {
      Property(node) {
        if (node.parent.type !== "ObjectExpression") return;
        if (recordingOptions.has(keyName(context, node.key, node.computed))) {
          context.report({ node, messageId: "recording" });
        }
      },
      AssignmentExpression(node) {
        const target = node.left;
        if (target.type !== "MemberExpression") return;
        if (recordingOptions.has(keyName(context, target.property, target.computed))) {
          context.report({ node, messageId: "recording" });
        }
      },
    };
  },
};
