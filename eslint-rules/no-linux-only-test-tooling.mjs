import { calleeName, constValue, memberName } from "./util.mjs";

const spawns = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]);
const comparisons = new Set(["===", "!==", "==", "!="]);

const staticString = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node.type === "Identifier") return staticString(context, constValue(context, node), seen);
  return null;
};

const readsPlatform = (node) =>
  memberName(node) === "platform" && node.object.type === "Identifier" && node.object.name === "process";

export default {
  meta: {
    type: "problem",
    docs: { description: "Test servers and their helpers must run on macOS as well as Linux." },
    messages: {
      binary: "Use the portable build lock helper instead of the Linux-only flock binary.",
      platform: "Keep test tooling portable instead of checking for Linux.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!spawns.has(calleeName(node))) return;
        let command = staticString(context, node.arguments[0]);
        if (/(?:^|\/)env$/.test(command ?? "") && node.arguments[1]?.type === "ArrayExpression") {
          command = staticString(context, node.arguments[1].elements[0]);
        }
        if (/^(?:\S*\/)?flock(?:\s|$)/.test(command ?? "")) context.report({ node, messageId: "binary" });
      },
      BinaryExpression(node) {
        if (!comparisons.has(node.operator)) return;
        if (
          (readsPlatform(node.left) && staticString(context, node.right) === "linux") ||
          (readsPlatform(node.right) && staticString(context, node.left) === "linux")
        ) context.report({ node, messageId: "platform" });
      },
    };
  },
};
