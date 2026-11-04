const comment = String.raw`(?:\/\*[\s\S]*?\*\/\s*)*`;
const scriptingFeature = new RegExp(String.raw`\(\s*${comment}scripting\s*${comment}[:)]`, "gi");

export const cssAsText = {
  meta: { name: "css-as-text" },
  preprocess: (text) => [{ text: "`" + text.replace(/[`$\\]/g, " ") + "`;", filename: "stylesheet.js" }],
  postprocess: (messages) =>
    messages.flat().map((message) => ({
      ...message,
      column: message.line === 1 ? Math.max(1, message.column - 1) : message.column,
      endColumn: message.endLine === 1 && message.endColumn ? Math.max(1, message.endColumn - 1) : message.endColumn,
    })),
  supportsAutofix: false,
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Styles must not depend on the scripting media feature, which Safari before 17 ignores.",
    },
    messages: {
      scripting:
        "Safari before 17 ignores the scripting media feature, so styles behind it never apply there. " +
        "Make the no-JavaScript styles the default and put JavaScript-only styles under html.js.",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    const check = (node) => {
      const text = sourceCode.getText(node);
      for (const match of text.matchAll(scriptingFeature)) {
        const start = node.range[0] + match.index;
        context.report({
          node,
          loc: {
            start: sourceCode.getLocFromIndex(start),
            end: sourceCode.getLocFromIndex(start + match[0].length),
          },
          messageId: "scripting",
        });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value === "string") check(node);
      },
      TemplateElement: check,
      JSXText: check,
    };
  },
};
