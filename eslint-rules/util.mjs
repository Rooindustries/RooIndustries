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

export const propertyName = (property) => {
  if (property?.type !== "Property" || property.computed) return "";
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return String(property.key.value);
  return "";
};

export const memberName = (member) => {
  if (member?.type !== "MemberExpression") return "";
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal" && typeof member.property.value === "string") {
    return member.property.value;
  }
  return "";
};

export const referenceName = (node) => (node?.type === "Identifier" ? node.name : memberName(node));

export const calleeName = (call) => referenceName(call.callee);

export const declaredValue = (context, identifier) => {
  let variable = null;
  for (let scope = context.sourceCode.getScope(identifier); scope && !variable; scope = scope.upper) {
    variable = scope.set.get(identifier.name) || null;
  }
  const definition = variable?.defs?.[0];
  if (!definition || definition.type !== "Variable" || definition.node.id.type !== "Identifier") return null;
  return definition.node.init || null;
};

export const isFetchCall = (call) => {
  const callee = call.callee;
  if (callee.type === "Identifier") return callee.name === "fetch";
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.name === "fetch" &&
    callee.object.type === "Identifier" &&
    ["window", "globalThis", "self"].includes(callee.object.name)
  );
};

export const containsNode = (root, test, { skip } = {}) => {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node.type !== "string") continue;
    if (node !== root && skip?.(node)) continue;
    if (node !== root && test(node)) return true;
    for (const [key, value] of Object.entries(node)) {
      if (key === "parent") continue;
      if (Array.isArray(value)) stack.push(...value);
      else if (value && typeof value.type === "string") stack.push(value);
    }
  }
  return false;
};

const isJsx = (node) => node?.type === "JSXElement" || node?.type === "JSXFragment";

export const returnsJsx = (fn) => isJsx(fn.body) || containsNode(fn.body, isJsx);
