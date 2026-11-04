import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindingDefinition, constValue, destructuredConst } from "./util.mjs";

const helperModule = fileURLToPath(new URL("../scripts/lib/node-options.mjs", import.meta.url));
const helpers = new Set(["appendNodeOption", "prependNodeOption"]);
const keepsOneSide = new Set(["??", "||"]);
const setsWhenEmpty = new Set(["=", "??=", "||=", "&&="]);

const staticString = (node) => {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  return null;
};

const keyName = (context, node, computed, seen = new Set()) => {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type !== "Identifier") return staticString(node);
  if (seen.has(node)) return null;
  seen.add(node);
  const value = constValue(context, node);
  return value ? keyName(context, value, true, seen) : null;
};

const readsNodeOptions = (context, node) =>
  node.type === "MemberExpression" && keyName(context, node.property, node.computed) === "NODE_OPTIONS";

const unwrap = (node) => (node?.type === "ChainExpression" ? node.expression : node);

const isHelperModule = (context, source) => {
  const specifier = staticString(source);
  return specifier !== null && path.resolve(path.dirname(context.filename), specifier) === helperModule;
};

const loadsHelperModule = (context, value) => {
  const node = value?.type === "AwaitExpression" ? value.argument : value;
  if (node?.type === "ImportExpression") return isHelperModule(context, node.source);
  return (
    node?.type === "CallExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "require" &&
    node.arguments.length === 1 &&
    isHelperModule(context, node.arguments[0])
  );
};

const exportsHelper = (context, definition) => {
  if (context.filename !== helperModule || !helpers.has(definition.name.name)) return false;
  if (definition.type === "FunctionName") return definition.node.parent.type === "ExportNamedDeclaration";
  return definition.type === "Variable" && definition.parent.kind === "const" && definition.parent.parent.type === "ExportNamedDeclaration";
};

const isHelperBinding = (context, identifier) => {
  const definition = bindingDefinition(context, identifier);
  if (!definition) return false;
  if (definition.type === "ImportBinding") {
    const { node } = definition;
    const imported = node.type === "ImportSpecifier" ? node.imported.name ?? node.imported.value : null;
    return helpers.has(imported) && isHelperModule(context, definition.parent.source);
  }
  if (exportsHelper(context, definition)) return true;
  const destructured = destructuredConst(context, identifier);
  return (
    Boolean(destructured) &&
    !destructured.fallback &&
    helpers.has(keyName(context, destructured.property.key, destructured.property.computed)) &&
    loadsHelperModule(context, destructured.source)
  );
};

const isHelperModuleObject = (context, identifier) => {
  const definition = bindingDefinition(context, identifier);
  if (definition?.type === "ImportBinding") {
    return definition.node.type === "ImportNamespaceSpecifier" && isHelperModule(context, definition.parent.source);
  }
  return loadsHelperModule(context, constValue(context, identifier));
};

const callsHelper = (context, call) => {
  const callee = unwrap(call.callee);
  if (callee.type === "Identifier") return isHelperBinding(context, callee);
  return (
    callee.type === "MemberExpression" &&
    callee.object.type === "Identifier" &&
    helpers.has(keyName(context, callee.property, callee.computed)) &&
    isHelperModuleObject(context, callee.object)
  );
};

const passesThrough = (context, identifier, memo) => {
  const destructured = destructuredConst(context, identifier);
  if (!destructured) return isAllowed(context, constValue(context, identifier), memo);
  if (keyName(context, destructured.property.key, destructured.property.computed) !== "NODE_OPTIONS") return false;
  return !destructured.fallback || isAllowed(context, destructured.fallback, memo);
};

const checkValue = (context, node, memo) => {
  switch (node.type) {
    case "Literal":
      return node.value === null || typeof node.value === "string";
    case "TemplateLiteral":
      return !node.expressions.length;
    case "Identifier":
      return node.name === "undefined" || passesThrough(context, node, memo);
    case "UnaryExpression":
      return node.operator === "void";
    case "CallExpression":
      return callsHelper(context, node);
    case "MemberExpression":
      return readsNodeOptions(context, node);
    case "ConditionalExpression":
      return isAllowed(context, node.consequent, memo) && isAllowed(context, node.alternate, memo);
    case "LogicalExpression":
      return keepsOneSide.has(node.operator) && isAllowed(context, node.left, memo) && isAllowed(context, node.right, memo);
    default:
      return false;
  }
};

const isAllowed = (context, value, memo) => {
  const node = unwrap(value);
  if (!node) return false;
  if (memo.has(node)) return memo.get(node);
  memo.set(node, false);
  const allowed = checkValue(context, node, memo);
  memo.set(node, allowed);
  return allowed;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "NODE_OPTIONS may only be set from the quoting helpers, a plain string, or an existing NODE_OPTIONS value, because a hand-built value leaves module paths unquoted.",
    },
    messages: {
      handBuilt:
        "Set NODE_OPTIONS with withNodeOption or appendNodeOption from scripts/lib/node-options.mjs, a plain string, or an existing NODE_OPTIONS value, so a path with a space or a quote still loads.",
    },
    schema: [],
  },
  create(context) {
    const memo = new WeakMap();
    return {
      Property(node) {
        if (node.parent.type !== "ObjectExpression" || keyName(context, node.key, node.computed) !== "NODE_OPTIONS") return;
        if (node.kind !== "init" || !isAllowed(context, node.value, memo)) context.report({ node: node.value, messageId: "handBuilt" });
      },
      AssignmentExpression(node) {
        const target = unwrap(node.left);
        if (target.type !== "MemberExpression" || !readsNodeOptions(context, target)) return;
        if (!setsWhenEmpty.has(node.operator) || !isAllowed(context, node.right, memo)) context.report({ node: node.right, messageId: "handBuilt" });
      },
    };
  },
};
