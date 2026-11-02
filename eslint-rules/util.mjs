export const jsxName = (node) => {
  if (!node) return "";
  if (node.type === "JSXIdentifier") return node.name;
  if (node.type === "JSXMemberExpression") return `${jsxName(node.object)}.${jsxName(node.property)}`;
  return "";
};

export const attribute = (opening, name) =>
  opening.attributes.find((item) => item.type === "JSXAttribute" && jsxName(item.name) === name);

export const literalValue = (attr) => {
  if (!attr?.value) return null;
  if (attr.value.type === "Literal") return attr.value.value;
  if (attr.value.type === "JSXExpressionContainer" && attr.value.expression.type === "Literal") {
    return attr.value.expression.value;
  }
  if (
    attr.value.type === "JSXExpressionContainer" &&
    attr.value.expression.type === "TemplateLiteral" &&
    attr.value.expression.expressions.length === 0
  ) {
    return attr.value.expression.quasis[0].value.cooked;
  }
  return null;
};

export const isCapitalized = (name) => typeof name === "string" && /^[A-Z]/.test(name);

export const functionName = (node) => {
  if (!node) return "";
  if (node.type === "FunctionDeclaration" && node.id) return node.id.name;
  if (
    (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") &&
    node.parent?.type === "VariableDeclarator" &&
    node.parent.id.type === "Identifier"
  ) {
    return node.parent.id.name;
  }
  return "";
};

export const isFunction = (node) =>
  node?.type === "FunctionDeclaration" ||
  node?.type === "FunctionExpression" ||
  node?.type === "ArrowFunctionExpression";

export const ancestors = (context, node) => context.sourceCode.getAncestors(node);

export const enclosingComponent = (context, node) =>
  [...ancestors(context, node)]
    .reverse()
    .find((item) => isFunction(item) && isCapitalized(functionName(item)));

export const calleeName = (call) => {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return "";
};
