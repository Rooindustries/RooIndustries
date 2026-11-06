import { bindingDefinition, constValue, containsNode, isFunction, memberName } from "./util.mjs";

const spawns = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"];

const staticString = (context, node, seen = new Set()) => {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && !node.expressions.length) return node.quasis[0].value.cooked;
  if (node.type === "Identifier") return staticString(context, constValue(context, node), seen);
  return null;
};

const moduleSource = (value, name) => value === name || value === `node:${name}`;
const moduleObject = (context, node, name, seen = new Set()) => {
  if (!node || seen.has(node)) return false;
  seen.add(node);
  if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "require") {
    return moduleSource(staticString(context, node.arguments[0]), name);
  }
  if (node.type !== "Identifier") return false;
  const definition = bindingDefinition(context, node);
  if (!definition) return name === "process" && node.name === "process";
  if (definition.type === "ImportBinding") {
    return definition.node.type !== "ImportSpecifier" && moduleSource(definition.parent.source.value, name);
  }
  return moduleObject(context, constValue(context, node), name, seen);
};

const moduleMember = (context, node, name, member) => {
  if (!node) return false;
  if (node.type === "MemberExpression") {
    return memberName(node) === member && moduleObject(context, node.object, name);
  }
  if (node.type !== "Identifier") return false;
  const definition = bindingDefinition(context, node);
  if (definition?.type === "ImportBinding" && definition.node.type === "ImportSpecifier") {
    return moduleSource(definition.parent.source.value, name) &&
      (definition.node.imported.name ?? definition.node.imported.value) === member;
  }
  if (definition?.type !== "Variable" || definition.node.id.type !== "ObjectPattern") return false;
  const property = definition.node.id.properties.find((entry) =>
    entry.type === "Property" && entry.value.type === "Identifier" && entry.value.name === node.name);
  return Boolean(property && (property.key.name ?? property.key.value) === member &&
    moduleObject(context, definition.node.init, name));
};

const includesNode = (node, check) => Boolean(node && (check(node) || containsNode(node, check, { skip: isFunction })));
const flockCommand = (command) =>
  /(?:^|[;&|()\n])\s*(?:exec\s+)?(?:\S*\/)?flock(?:\s|$)/.test(command ?? "") ||
  /(?:^|\s)(?:\S*\/)?(?:sh|bash)\s+-\w*c\s+["']\s*(?:exec\s+)?(?:\S*\/)?flock(?:\s|$)/.test(command ?? "");

export default {
  meta: {
    type: "problem",
    docs: { description: "Test servers and their helpers must run on macOS as well as Linux." },
    messages: {
      binary: "Use the portable build lock helper instead of the Linux-only flock binary.",
      platform: "Keep test tooling portable instead of refusing a platform.",
    },
    schema: [],
  },
  create(context) {
    const readsPlatform = (node) => moduleMember(context, node, "process", "platform") ||
      (node.type === "CallExpression" && moduleMember(context, node.callee, "os", "platform"));
    const refuses = (node) => includesNode(node, (child) => child.type === "ThrowStatement" ||
      (child.type === "CallExpression" && moduleMember(context, child.callee, "process", "exit")));
    const checkBranch = (node, test, branches) => {
      if (includesNode(test, readsPlatform) && branches.some(refuses)) {
        context.report({ node, messageId: "platform" });
      }
    };
    return {
      CallExpression(node) {
        if (!spawns.some((name) => moduleMember(context, node.callee, "child_process", name))) return;
        let command = staticString(context, node.arguments[0]);
        let args = node.arguments[1]?.type === "ArrayExpression" ? node.arguments[1].elements : [];
        if (/(?:^|\/)env$/.test(command ?? "")) {
          command = staticString(context, args[0]);
          args = args.slice(1);
        }
        if (/(?:^|\/)(?:sh|bash)$/.test(command ?? "")) {
          const option = args.findIndex((arg) => /^-\w*c\w*$/.test(staticString(context, arg) ?? ""));
          command = option < 0 ? null : staticString(context, args[option + 1]);
        }
        if (flockCommand(command)) context.report({ node, messageId: "binary" });
      },
      IfStatement(node) {
        checkBranch(node, node.test, [node.consequent, node.alternate]);
      },
      ConditionalExpression(node) {
        checkBranch(node, node.test, [node.consequent, node.alternate]);
      },
      SwitchStatement(node) {
        checkBranch(node, node.discriminant, node.cases);
      },
    };
  },
};
