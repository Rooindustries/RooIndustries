import { attribute, jsxName, literalValue } from "./util.mjs";

const normalize = (text) =>
  String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const visibleText = (element) => {
  const parts = [];
  for (const child of element.children || []) {
    if (child.type === "JSXText") parts.push(child.value);
    if (child.type !== "JSXElement") continue;
    const opening = child.openingElement;
    if (
      literalValue(attribute(opening, "aria-hidden")) === "true" ||
      attribute(opening, "aria-hidden")?.value === null
    )
      continue;
    if (/\bsr-only\b/.test(String(literalValue(attribute(opening, "className")) || ""))) continue;
    if (jsxName(opening.name) === "img" || jsxName(opening.name) === "Image") {
      parts.push(String(literalValue(attribute(opening, "alt")) || ""));
      continue;
    }
    parts.push(visibleText(child));
  }
  return parts.join(" ");
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "An aria-label must contain the text people see, or voice control and screen readers disagree with " +
        "the screen.",
    },
    messages: { mismatch: 'The aria-label "{{label}}" doesn\'t include the visible text "{{text}}".' },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        if (!["a", "button", "Link"].includes(jsxName(node.openingElement.name))) return;
        const label = literalValue(attribute(node.openingElement, "aria-label"));
        if (typeof label !== "string") return;
        const text = normalize(visibleText(node));
        if (!/[a-z]/.test(text)) return;
        if (!normalize(label).includes(text)) {
          context.report({ node: node.openingElement, messageId: "mismatch", data: { label, text } });
        }
      },
    };
  },
};
