import { declaredValue, findVariable, isFunction } from "./util.mjs";

const loaders = new Set(["getPublicContent", "fetchHomeSectionData", "prefetchHomeSectionData"]);
const combinators = new Set(["all", "any", "race"]);
const reporters = new Set(["captureException", "captureMessage", "reportError"]);
const consoleMethods = new Set(["error", "warn"]);
const helperName = "reportContentLoadError";
const helperModule = /(^|\/)publicContentClient(\.js)?$/;

const calleeName = (callee) => {
  if (callee?.type === "Identifier") return callee.name;
  if (callee?.type === "MemberExpression" && !callee.computed) return callee.property.name;
  return "";
};

const isReporter = (node) => {
  if (node?.type === "MemberExpression" && !node.computed && node.object.type === "Identifier") {
    if (node.object.name === "console") return consoleMethods.has(node.property.name);
  }
  return reporters.has(calleeName(node));
};

const isAbsent = (node) =>
  !node ||
  (node.type === "Literal" && node.value === null) ||
  (node.type === "Identifier" && node.name === "undefined");

const rejectionHandler = (call, method) => {
  if (method === "catch") return call.arguments[0];
  if (method === "then") return call.arguments[1];
  return null;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "A content load failure logged outside reportContentLoadError reports requests the browser cut off because the visitor left.",
    },
    messages: {
      unfiltered:
        "Pass this content load failure to reportContentLoadError so a request cut off by leaving the page isn't reported.",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    const reported = new Set();
    const report = (node) => {
      if (!node || reported.has(node)) return;
      reported.add(node);
      context.report({ node, messageId: "unfiltered" });
    };

    const isHelper = (node) => {
      if (node?.type !== "Identifier") return false;
      const definition = findVariable(context, node)?.defs?.[0];
      if (definition?.type !== "ImportBinding" || definition.node.type !== "ImportSpecifier") return false;
      const { imported } = definition.node;
      return (imported.name ?? imported.value) === helperName && helperModule.test(definition.parent.source.value);
    };

    const isContentPromise = (node, seen = new Set()) => {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      if (node.type === "Identifier") {
        const init = declaredValue(context, node);
        return init?.parent?.parent?.kind === "const" && isContentPromise(init, seen);
      }
      if (node.type !== "CallExpression") return false;
      const { callee } = node;
      if (callee.type === "Identifier") return loaders.has(callee.name);
      if (callee.type !== "MemberExpression" || callee.computed) return false;
      const method = callee.property.name;
      if (callee.object.type === "Identifier" && callee.object.name === "Promise" && combinators.has(method)) {
        const list = node.arguments[0];
        return list?.type === "ArrayExpression" && list.elements.some((item) => isContentPromise(item, seen));
      }
      if (!["then", "catch", "finally"].includes(method)) return false;
      const handler = rejectionHandler(node, method);
      const passesOn = isAbsent(handler) || (isFunction(handler) && rethrows(handler, handler.params[0]));
      return passesOn && isContentPromise(callee.object, seen);
    };

    const errorVariable = (owner, param) =>
      param?.type === "Identifier" ? sourceCode.getDeclaredVariables(owner).find((item) => item.name === param.name) : null;

    const directlyIn = (node, owner) => {
      for (let current = node.parent; current && current !== owner; current = current.parent) {
        if (isFunction(current)) return false;
      }
      return true;
    };

    const isRejection = (call) =>
      call.callee.type === "MemberExpression" &&
      !call.callee.computed &&
      call.callee.object.type === "Identifier" &&
      call.callee.object.name === "Promise" &&
      call.callee.property.name === "reject";

    const isRethrow = (identifier, owner) => {
      const { parent } = identifier;
      if (parent.type === "ThrowStatement") return directlyIn(parent, owner);
      if (parent.type !== "CallExpression" || parent.arguments[0] !== identifier || !isRejection(parent)) return false;
      const returned =
        (parent.parent.type === "ReturnStatement" && parent.parent.argument === parent) ||
        (parent.parent === owner && owner.body === parent);
      return returned && directlyIn(parent, owner);
    };

    const isHelperArgument = (identifier) =>
      identifier.parent.type === "CallExpression" &&
      identifier.parent.arguments[0] === identifier &&
      isHelper(identifier.parent.callee);

    const rethrows = (owner, param) =>
      errorVariable(owner, param)?.references.some((ref) => isRethrow(ref.identifier, owner)) ?? false;

    const errorLeak = (owner, param) => {
      if (!param) return null;
      if (param.type !== "Identifier") return param;
      const uses = errorVariable(owner, param)?.references ?? [];
      return uses.find((ref) => !isHelperArgument(ref.identifier) && !isRethrow(ref.identifier, owner))?.identifier;
    };

    const reporterCall = (root) => {
      const stack = [root];
      while (stack.length) {
        const node = stack.pop();
        if (node.type === "CallExpression" && !isHelper(node.callee) && isReporter(node.callee)) return node;
        for (const key of sourceCode.visitorKeys[node.type] ?? []) {
          const child = node[key];
          if (Array.isArray(child)) child.forEach((item) => item && stack.push(item));
          else if (child) stack.push(child);
        }
      }
      return null;
    };

    const leak = (owner, param) => errorLeak(owner, param) ?? reporterCall(owner.body);

    const handlerLeak = (handler) => {
      if (isFunction(handler)) return leak(handler, handler.params[0]);
      return isHelper(handler) ? null : handler;
    };

    return {
      CallExpression(call) {
        const { callee } = call;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const handler = rejectionHandler(call, callee.property.name);
        if (isAbsent(handler) || !isContentPromise(callee.object)) return;
        report(handlerLeak(handler));
      },
      AwaitExpression(node) {
        if (!isContentPromise(node.argument)) return;
        for (let child = node; child.parent && !isFunction(child.parent); child = child.parent) {
          const parent = child.parent;
          if (parent.type === "TryStatement" && parent.block === child && parent.handler) {
            const { handler } = parent;
            report(leak(handler, handler.param));
            if (!rethrows(handler, handler.param)) return;
          }
        }
      },
    };
  },
};
