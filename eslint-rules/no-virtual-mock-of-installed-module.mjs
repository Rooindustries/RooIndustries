import { createRequire } from "node:module";
import { propertyName } from "./util.mjs";

const mockCalls = new Set(["mock", "doMock", "setMock"]);

const isJestMock = (callee) =>
  callee.type === "MemberExpression" &&
  !callee.computed &&
  callee.object.type === "Identifier" &&
  callee.object.name === "jest" &&
  mockCalls.has(callee.property.name);

const marksVirtual = (options) =>
  options?.type === "ObjectExpression" &&
  options.properties.some(
    (property) => propertyName(property) === "virtual" && property.value.type === "Literal" && property.value.value === true
  );

const extensions = ["", ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];

const candidates = (name) =>
  name.startsWith(".") ? [...extensions.map((ext) => name + ext), ...extensions.slice(1).map((ext) => `${name}/index${ext}`)] : [name];

const resolves = (filename, name) => {
  const require = createRequire(filename);
  return candidates(name).some((candidate) => {
    try {
      require.resolve(candidate);
      return true;
    } catch {
      return false;
    }
  });
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Jest caches module IDs per worker, so a virtual mock of an installed module makes later test files in that worker load the real module past their own mocks.",
    },
    messages: {
      installed: "\"{{name}}\" is installed, so mock it without { virtual: true }.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isJestMock(node.callee)) return;
        const [target, , options] = node.arguments;
        if (target?.type !== "Literal" || typeof target.value !== "string" || !marksVirtual(options)) return;
        if (resolves(context.filename, target.value)) {
          context.report({ node: options, messageId: "installed", data: { name: target.value } });
        }
      },
    };
  },
};
