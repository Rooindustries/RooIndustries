import { declaredValue, isFunction } from "./util.mjs";

const dynamic = null;

const isNodeOptionsKey = (node, computed) =>
  (!computed && node.type === "Identifier" && node.name === "NODE_OPTIONS") ||
  (node.type === "Literal" && node.value === "NODE_OPTIONS");

const opensModulePath = /(?:^|\s)(?:--import|--require|-r|--loader|--experimental-loader)(?:=|\s+)\S*$/;

const keepsElements = new Set(["filter", "flat", "slice", "reverse", "sort", "toReversed", "toSorted"]);
const keepsText = new Set(["trim", "trimStart", "trimEnd", "toString"]);

const methodName = (call) =>
  call.callee.type === "MemberExpression" && !call.callee.computed && call.callee.property.type === "Identifier"
    ? call.callee.property.name
    : "";

const returnedValues = (fn) => {
  if (!isFunction(fn)) return [];
  if (fn.body.type !== "BlockStatement") return [fn.body];
  return fn.body.body.filter((statement) => statement.type === "ReturnStatement" && statement.argument).map((statement) => statement.argument);
};

const resolved = (context, identifier, seen, read) => {
  const value = declaredValue(context, identifier);
  return value && !seen.has(value) ? read(context, value, new Set(seen).add(value)) : null;
};

const textParts = (context, node, seen) => {
  if (!node) return [dynamic];
  switch (node.type) {
    case "Literal":
      return [String(node.value)];
    case "TemplateLiteral":
      return node.quasis.flatMap((quasi, index) => [
        quasi.value.cooked ?? "",
        ...(index < node.expressions.length ? textParts(context, node.expressions[index], seen) : []),
      ]);
    case "BinaryExpression":
      return node.operator === "+" ? [...textParts(context, node.left, seen), ...textParts(context, node.right, seen)] : [dynamic];
    case "Identifier":
      return resolved(context, node, seen, textParts) ?? [dynamic];
    case "CallExpression": {
      const name = methodName(node);
      const target = node.callee.object;
      if (keepsText.has(name)) return textParts(context, target, seen);
      if (name === "concat" && !arrayElements(context, target, seen)) {
        return [...textParts(context, target, seen), ...node.arguments.flatMap((argument) => textParts(context, argument, seen))];
      }
      if (name !== "join") return [dynamic];
      const elements = arrayElements(context, target, seen);
      const separator = node.arguments.length ? textParts(context, node.arguments[0], seen) : [","];
      return elements ? elements.flatMap((element, index) => (index ? [...separator, ...element] : element)) : [dynamic];
    }
    default:
      return [dynamic];
  }
};

const arrayElements = (context, node, seen) => {
  if (!node) return null;
  if (node.type === "Identifier") return resolved(context, node, seen, arrayElements);
  if (node.type === "ArrayExpression") {
    return node.elements.flatMap((element) =>
      element?.type === "SpreadElement" ? arrayElements(context, element.argument, seen) ?? [[dynamic]] : [textParts(context, element, seen)]);
  }
  if (node.type !== "CallExpression") return null;
  const name = methodName(node);
  const target = node.callee.object;
  if (keepsElements.has(name)) return arrayElements(context, target, seen);
  if (name === "map") return returnedValues(node.arguments[0]).map((value) => textParts(context, value, seen));
  if (name === "concat") {
    const head = arrayElements(context, target, seen);
    return head && [...head, ...node.arguments.flatMap((argument) => arrayElements(context, argument, seen) ?? [textParts(context, argument, seen)])];
  }
  return null;
};

const subExpressions = (context, node) => {
  switch (node.type) {
    case "TemplateLiteral":
      return node.expressions;
    case "BinaryExpression":
    case "LogicalExpression":
      return [node.left, node.right];
    case "ConditionalExpression":
      return [node.consequent, node.alternate];
    case "Identifier":
      return [declaredValue(context, node)];
    case "ArrayExpression":
      return node.elements.map((element) => (element?.type === "SpreadElement" ? element.argument : element));
    case "CallExpression": {
      const name = methodName(node);
      if (!["join", "concat", "map", ...keepsText, ...keepsElements].includes(name)) return [];
      return [node.callee.object, ...node.arguments, ...(name === "map" ? returnedValues(node.arguments[0]) : [])];
    }
    default:
      return [];
  }
};

const opensPathBeforeDynamic = (parts) => {
  let text = "";
  for (const part of parts) {
    if (part !== dynamic) text += part;
    else if (opensModulePath.test(text)) return true;
    else text = "";
  }
  return false;
};

const buildsModulePath = (context, root) => {
  const stack = [root];
  const visited = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    if (opensPathBeforeDynamic(textParts(context, node, new Set()))) return true;
    stack.push(...subExpressions(context, node));
  }
  return false;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "NODE_OPTIONS built from strings leaves module paths unquoted, so a checkout path with a space or quote stops Node from starting.",
    },
    messages: {
      handBuilt:
        "This builds NODE_OPTIONS by hand, which breaks when a path has a space or a quote. Use withNodeOption from scripts/lib/node-options.mjs.",
    },
    schema: [],
  },
  create(context) {
    return {
      Property(node) {
        if (isNodeOptionsKey(node.key, node.computed) && buildsModulePath(context, node.value)) {
          context.report({ node: node.value, messageId: "handBuilt" });
        }
      },
      AssignmentExpression(node) {
        const { left } = node;
        if (left.type !== "MemberExpression" || !isNodeOptionsKey(left.property, left.computed)) return;
        if (buildsModulePath(context, node.right)) context.report({ node: node.right, messageId: "handBuilt" });
      },
    };
  },
};
