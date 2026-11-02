import { ancestors, attribute, jsxName, literalValue } from "./util.mjs";

const fieldTypes = new Set(["text", "email", "password", "tel", "url", "number"]);

export default {
  meta: {
    type: "problem",
    docs: { description: "A form field that only has an aria-label shows no visible label." },
    messages: {
      label:
        "This field is named only by a fixed aria-label, so nobody sees its label. Give it a visible " +
        "<label> tied to it with htmlFor and id.",
    },
    schema: [],
  },
  create(context) {
    const labelled = new Set();
    const candidates = [];
    return {
      JSXOpeningElement(node) {
        const name = jsxName(node.name);
        if (name === "label") {
          const target = literalValue(attribute(node, "htmlFor"));
          if (typeof target === "string") labelled.add(target);
          return;
        }
        if (!["input", "textarea"].includes(name)) return;
        if (name === "input") {
          const typeAttr = attribute(node, "type");
          const type = typeAttr ? literalValue(typeAttr) : "text";
          if (typeof type !== "string" || !fieldTypes.has(type)) return;
        }
        if (
          typeof literalValue(attribute(node, "aria-label")) !== "string" ||
          attribute(node, "aria-labelledby")
        )
          return;
        if (
          ancestors(context, node).some(
            (item) => item.type === "JSXElement" && jsxName(item.openingElement.name) === "label",
          )
        )
          return;
        candidates.push(node);
      },
      "Program:exit"() {
        for (const node of candidates) {
          const id = literalValue(attribute(node, "id"));
          if (typeof id === "string" && labelled.has(id)) continue;
          context.report({ node, messageId: "label" });
        }
      },
    };
  },
};
