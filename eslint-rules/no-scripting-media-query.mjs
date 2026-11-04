import { scriptingAtRules, scriptingMessage, usesScriptingMedia } from "../scripts/lib/scripting-media.mjs";
import { attribute, calleeName, declaredValue, jsxName, propertyName } from "./util.mjs";

const unknown = "/**/";

const maxText = 1 << 16;

const staticText = (context, node, memo = new Map()) => {
  if (!node) return unknown;
  if (memo.has(node)) return memo.get(node) ?? unknown;
  memo.set(node, null);
  const text = resolveText(context, node, memo).slice(0, maxText);
  memo.set(node, text);
  return text;
};

const resolveText = (context, node, memo) => {
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : unknown;
  if (node.type === "TemplateLiteral") {
    return node.quasis
      .map((quasi, index) => {
        const expression = node.expressions[index];
        return (quasi.value.cooked ?? "") + (expression ? staticText(context, expression, memo) : "");
      })
      .join("");
  }
  if (node.type === "JSXText") return node.value;
  if (node.type === "JSXExpressionContainer") return staticText(context, node.expression, memo);
  if (node.type === "Identifier") return staticText(context, declaredValue(context, node), memo);
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return staticText(context, node.left, memo) + staticText(context, node.right, memo);
  }
  return unknown;
};

const innerHtml = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return unknown;
  seen.add(node);
  if (node.type === "JSXExpressionContainer") return innerHtml(context, node.expression, seen);
  if (node.type === "Identifier") return innerHtml(context, declaredValue(context, node), seen);
  if (node.type !== "ObjectExpression") return unknown;
  const html = node.properties.findLast((property) => propertyName(property) === "__html");
  return html ? staticText(context, html.value) : unknown;
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
        if (calleeName(node) !== "matchMedia" || !node.arguments[0]) return;
        if (usesScriptingMedia(staticText(context, node.arguments[0]))) report(node.arguments[0]);
      },
      JSXAttribute(node) {
        if (jsxName(node.name) !== "media" || !/^[a-z]/.test(jsxName(node.parent.name))) return;
        if (usesScriptingMedia(staticText(context, node.value))) report(node);
      },
      JSXElement(node) {
        const opening = node.openingElement;
        if (jsxName(opening.name) !== "style") return;
        const html = attribute(opening, "dangerouslySetInnerHTML");
        const css = html
          ? innerHtml(context, html.value)
          : node.children.map((child) => staticText(context, child)).join("");
        if (inlineCssUsesScripting(css)) report(opening);
      },
    };
  },
};
