import { isFunction } from "./util.mjs";

const loaders = new Set(["getPublicContent", "fetchHomeSectionData", "prefetchHomeSectionData"]);
const reporters = new Set(["captureException", "captureMessage", "reportError"]);
const consoleMethods = new Set(["error", "warn"]);

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

const findReport = (sourceCode, root) => {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (node.type === "CallExpression" && isReporter(node.callee)) return node;
    for (const key of sourceCode.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((item) => item && stack.push(item));
      else if (child) stack.push(child);
    }
  }
  return null;
};

const handlerReport = (sourceCode, handler) => {
  if (!handler) return null;
  if (isReporter(handler)) return handler;
  if (isFunction(handler)) return findReport(sourceCode, handler.body);
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
    return {
      CallExpression(call) {
        if (call.callee.type !== "Identifier" || !loaders.has(call.callee.name)) return;
        let current = call;
        for (;;) {
          const member = current.parent;
          const next = member?.parent;
          if (
            member?.type !== "MemberExpression" ||
            member.object !== current ||
            member.computed ||
            next?.type !== "CallExpression" ||
            next.callee !== member
          )
            break;
          const method = member.property.name;
          if (method === "catch") report(handlerReport(sourceCode, next.arguments[0]));
          else if (method === "then") report(handlerReport(sourceCode, next.arguments[1]));
          else if (method !== "finally") break;
          current = next;
        }
        for (let node = call; node.parent && !isFunction(node.parent); node = node.parent) {
          const parent = node.parent;
          if (parent.type === "TryStatement" && parent.block === node && parent.handler) {
            report(findReport(sourceCode, parent.handler.body));
          }
        }
      },
    };
  },
};
