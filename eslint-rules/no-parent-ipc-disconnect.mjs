const childProcessModules = new Set(["child_process", "node:child_process"]);
const factories = new Set(["spawn", "fork", "execFile", "exec"]);
const propertyName = (node) => node.computed ? node.property.value : node.property.name;

export default {
  meta: {
    type: "problem",
    docs: {
      description: "A child process whose parent ends its IPC channel never emits close.",
    },
    messages: {
      parent: "Let the child end the channel and unref it here, so close still fires.",
    },
    schema: [],
  },
  create(context) {
    const variable = (node) => {
      for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
        if (scope.set.has(node.name)) return scope.set.get(node.name);
      }
    };
    const fromBinding = (node, seen, matches, imported) => {
      const binding = variable(node);
      if (!binding || seen.has(binding)) return false;
      const next = new Set(seen).add(binding);
      return binding.defs.some((definition) => {
        if (definition.type === "ImportBinding") {
          return childProcessModules.has(definition.parent.source.value) && imported(definition.node);
        }
        const declaration = definition.node;
        if (declaration.type !== "VariableDeclarator") return false;
        if (declaration.id.type === "ObjectPattern") {
          const property = declaration.id.properties.find((entry) => entry.value?.name === node.name);
          return property && isModule(declaration.init, next) && imported({
            type: "ImportSpecifier", imported: property.key,
          });
        }
        return matches(declaration.init, next);
      }) || binding.references.some((reference) => reference.writeExpr && matches(reference.writeExpr, next));
    };
    const isModule = (node, seen = new Set()) => {
      if (!node) return false;
      if (node.type === "CallExpression") {
        return node.callee.name === "require" && childProcessModules.has(node.arguments[0]?.value);
      }
      return node.type === "Identifier" && fromBinding(node, seen, isModule,
        (specifier) => ["ImportNamespaceSpecifier", "ImportDefaultSpecifier"].includes(specifier.type));
    };
    const isFactory = (node, seen = new Set()) => {
      if (!node) return false;
      if (node.type === "MemberExpression") {
        return isModule(node.object, seen) && factories.has(propertyName(node));
      }
      return node.type === "Identifier" && fromBinding(node, seen, isFactory,
        (specifier) => specifier.type === "ImportSpecifier" && factories.has(specifier.imported.name || specifier.imported.value));
    };
    const isChild = (node, seen = new Set()) => {
      if (!node) return false;
      if (node.type === "CallExpression") return isFactory(node.callee, seen);
      return node.type === "Identifier" && fromBinding(node, seen, isChild, () => false);
    };
    return {
      MemberExpression(node) {
        if (propertyName(node) === "disconnect" && isChild(node.object)) {
          context.report({ node, messageId: "parent" });
        }
      },
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !isChild(node.init)) return;
        for (const property of node.id.properties) {
          if ((property.key?.name || property.key?.value) === "disconnect") {
            context.report({ node: property, messageId: "parent" });
          }
        }
      },
    };
  },
};
