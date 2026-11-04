import { scriptingAtRules, scriptingMessage, usesScriptingMedia } from "../scripts/lib/scripting-media.mjs";
import { calleeName, declaredValue, jsxName } from "./util.mjs";

const staticText = (context, node, depth = 0) => {
  if (!node || depth > 4) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral") return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("x");
  if (node.type === "JSXText") return node.value;
  if (node.type === "JSXExpressionContainer") return staticText(context, node.expression, depth);
  if (node.type === "Identifier") return staticText(context, declaredValue(context, node), depth + 1);
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticText(context, node.left, depth);
    const right = staticText(context, node.right, depth);
    return left === null || right === null ? null : left + right;
  }
  return null;
};

const inlineCssUsesScripting = (css) => {
  try {
    return scriptingAtRules(css).length > 0;
  } catch {
    return false;
  }
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Media queries in scripts and markup must not use the scripting feature, which Safari before 17 ignores.",
    },
    messages: { scripting: scriptingMessage },
    schema: [],
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: "scripting" });
    return {
      CallExpression(node) {
        if (calleeName(node) !== "matchMedia") return;
        const media = staticText(context, node.arguments[0]);
        if (media !== null && usesScriptingMedia(media)) report(node.arguments[0]);
      },
      JSXAttribute(node) {
        if (jsxName(node.name) !== "media" || !/^[a-z]/.test(jsxName(node.parent.name))) return;
        const media = staticText(context, node.value);
        if (media !== null && usesScriptingMedia(media)) report(node);
      },
      JSXElement(node) {
        if (jsxName(node.openingElement.name) !== "style") return;
        const css = node.children.map((child) => staticText(context, child) ?? "").join("");
        if (inlineCssUsesScripting(css)) report(node.openingElement);
      },
    };
  },
};
