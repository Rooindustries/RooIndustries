import path from "node:path";
import { fileURLToPath } from "node:url";
import { calleeName, memberName, referenceName } from "./util.mjs";

const HELPER_MODULE = fileURLToPath(new URL("../src/lib/scrollWindowTo.js", import.meta.url));
const PAGE_OFFSETS = new Set(["scrollY", "pageYOffset"]);

const isBoxTop = (node) =>
  memberName(node) === "top" &&
  node.object.type === "CallExpression" &&
  calleeName(node.object) === "getBoundingClientRect";

const isPageOffset = (node) => PAGE_OFFSETS.has(referenceName(node));

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "A page jump measured by hand skips revealing deferred sections, so it lands on estimated heights " +
        "and shifts again once they render.",
    },
    messages: {
      handMeasured:
        "Measure page jumps with scrollWindowToElement from src/lib/scrollWindowTo, so deferred sections " +
        "above the target render at their real height first.",
    },
    schema: [],
  },
  create(context) {
    if (path.resolve(context.filename) === HELPER_MODULE) return {};
    return {
      BinaryExpression(node) {
        if (node.operator !== "+") return;
        const operands = [node.left, node.right];
        if (operands.some(isBoxTop) && operands.some(isPageOffset)) {
          context.report({ node, messageId: "handMeasured" });
        }
      },
    };
  },
};
