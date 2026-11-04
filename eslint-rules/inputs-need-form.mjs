import {
  ancestors,
  attribute,
  calleeName,
  containsNode,
  functionName,
  isCapitalized,
  isFunction,
  jsxName,
  literalValue,
  referenceName,
} from "./util.mjs";

const textTypes = new Set(["text", "email", "password", "tel", "url", "number", "search"]);
const submitVerb =
  /^(handle)?(submit|save|update|check|apply|validate|login|register|confirm|send|verify|review)/i;

const settles = (node, parent) =>
  parent.type === "MemberExpression" &&
  parent.object === node &&
  parent.parent?.type === "CallExpression" &&
  parent.parent.callee === parent &&
  ["then", "catch", "finally"].includes(referenceName(parent));

const passesResult = (node, parent) =>
  parent.type === "AwaitExpression" ||
  parent.type === "ChainExpression" ||
  parent.type === "SequenceExpression" ||
  (parent.type === "UnaryExpression" && parent.operator === "void") ||
  (parent.type === "LogicalExpression" && parent.right === node) ||
  (parent.type === "ConditionalExpression" && parent.test !== node);

const discardsResult = (call) => {
  for (let node = call; node.parent; ) {
    const parent = node.parent;
    if (parent.type === "ExpressionStatement" || parent.type === "ReturnStatement") return true;
    if (parent.type === "ArrowFunctionExpression") return parent.body === node;
    if (settles(node, parent)) node = parent.parent;
    else if (passesResult(node, parent)) node = parent;
    else return false;
  }
  return false;
};

const isSubmitCall = (node) =>
  node.type === "CallExpression" && submitVerb.test(calleeName(node)) && discardsResult(node);

const submitsOnClick = (attr) => {
  const expression = attr?.value?.type === "JSXExpressionContainer" ? attr.value.expression : null;
  if (!expression) return false;
  if (expression.type === "Identifier" || expression.type === "MemberExpression") {
    return submitVerb.test(referenceName(expression));
  }
  return containsNode(expression, isSubmitCall, { skip: isFunction });
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
          const readOnly = attribute(node, "readOnly");
          if (readOnly && literalValue(readOnly) !== false) return;
          const typeAttr = attribute(node, "type");
          const type = typeAttr ? literalValue(typeAttr) : "text";
          if (typeof type === "string" && textTypes.has(type)) entry(component).inputs.push(node);
          return;
        }
        if (
          submitsOnClick(attribute(node, "onClick")) &&
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
