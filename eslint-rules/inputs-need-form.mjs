import {
  ancestors,
  attribute,
  functionName,
  isCapitalized,
  isFunction,
  jsxName,
  literalValue,
} from "./util.mjs";

const textTypes = new Set(["text", "email", "password", "tel", "url", "number"]);
const submitVerb =
  /^(handle)?(submit|save|update|check|apply|validate|login|register|confirm|send|verify|review|start)/i;

const submitHandlerName = (attr) => {
  const expression = attr?.value?.type === "JSXExpressionContainer" ? attr.value.expression : null;
  if (!expression) return "";
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "ArrowFunctionExpression") {
    const body =
      expression.body.type === "BlockStatement" &&
      expression.body.body.length === 1 &&
      expression.body.body[0].type === "ExpressionStatement"
        ? expression.body.body[0].expression
        : expression.body;
    if (body.type === "CallExpression" && body.callee.type === "Identifier") return body.callee.name;
  }
  return "";
};

const insideForm = (context, node) =>
  ancestors(context, node).some(
    (item) => item.type === "JSXElement" && jsxName(item.openingElement.name) === "form",
  );

const outermostComponent = (context, node) =>
  ancestors(context, node).find((item) => isFunction(item) && isCapitalized(functionName(item)));

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Text fields submitted by a button click instead of a form can't be submitted with Enter.",
    },
    messages: {
      form:
        "This field is submitted by a button's onClick outside a <form>, so Enter does nothing. Wrap them in " +
        "a form with onSubmit.",
    },
    schema: [],
  },
  create(context) {
    const components = new Map();
    const entry = (component) => {
      if (!components.has(component)) components.set(component, { inputs: [], clickButtons: 0 });
      return components.get(component);
    };
    return {
      JSXOpeningElement(node) {
        const name = jsxName(node.name);
        if (name !== "input" && name !== "button") return;
        const component = outermostComponent(context, node);
        if (!component || insideForm(context, node)) return;
        if (name === "input") {
          if (attribute(node, "readOnly")) return;
          const typeAttr = attribute(node, "type");
          const type = typeAttr ? literalValue(typeAttr) : "text";
          if (typeof type === "string" && textTypes.has(type)) entry(component).inputs.push(node);
          return;
        }
        if (
          submitVerb.test(submitHandlerName(attribute(node, "onClick"))) &&
          literalValue(attribute(node, "type")) !== "submit"
        ) {
          entry(component).clickButtons += 1;
        }
      },
      "Program:exit"() {
        for (const { inputs, clickButtons } of components.values()) {
          if (!clickButtons) continue;
          for (const input of inputs) context.report({ node: input, messageId: "form" });
        }
      },
    };
  },
};
