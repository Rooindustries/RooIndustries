import { ancestors, functionName, isCapitalized, isFunction, returnsJsx } from "./util.mjs";

export default {
  meta: {
    type: "problem",
    docs: { description: "Components defined inside another component remount on every render." },
    messages: {
      nested:
        "{{name}} is defined inside {{parent}}, so it remounts on every render. Move it to module scope.",
    },
    schema: [],
  },
  create(context) {
    const check = (fn) => {
      const name = functionName(fn);
      if (!isCapitalized(name) || !returnsJsx(fn)) return;
      const parent = [...ancestors(context, fn)]
        .reverse()
        .find((item) => isFunction(item) && isCapitalized(functionName(item)));
      if (parent)
        context.report({ node: fn, messageId: "nested", data: { name, parent: functionName(parent) } });
    };
    return {
      FunctionDeclaration: check,
      ArrowFunctionExpression: check,
      FunctionExpression: check,
    };
  },
};
